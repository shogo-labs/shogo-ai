// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * 3D generation and post-processing, through the AI proxy (`/ai/v1/3d/*`),
 * which holds the vendor key and bills per task. Opt-in behind
 * `threeDGenEnabled` — every task costs real money.
 *
 * `generate_3d_model` builds a model from a prompt, one image or four
 * multiview images. `edit_3d_model` runs every other Tripo V3 operation on an
 * existing model: texture, format convert, retopology, segmentation, mesh
 * completion, rig check, rig, animation retarget and import.
 *
 * Same submit → poll → save shape as `generate_video`, including the
 * `wait: false` + `job_id` hand-off. The helpers below are local on purpose:
 * `media-tools.ts` imports this module for `createMediaTools`, so importing
 * back from it would make the two cycle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, relative, resolve, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { assertWithinWorkspace } from './permission-engine'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export const THREE_D_DEFAULT_MODEL = 'tripo-v3.1'

/** Poll cadence and the blocking budget for `wait: true`. Tripo asks for ≤1 request/second. */
export const THREE_D_POLL = { intervalMs: 2_500, timeoutMs: 5 * 60_000 }

/** Post-process ops `edit_3d_model` accepts (the proxy's op ids). */
export const EDIT_3D_OPS = [
  'texture',
  'convert',
  'retopology',
  'segment',
  'complete',
  'rig_check',
  'rig',
  'retarget',
  'import',
] as const

export type Edit3DOp = (typeof EDIT_3D_OPS)[number]

/** Export format → file extension. GLTF comes back as binary glTF. */
const EXT_BY_FORMAT: Record<string, string> = {
  GLTF: '.glb',
  FBX: '.fbx',
  USDZ: '.usdz',
  OBJ: '.obj',
  STL: '.stl',
  '3MF': '.3mf',
}

/** Ops whose success carries part names instead of a downloadable model. */
const PART_OPS = new Set<string>(['segment', 'rig_check'])

type ThreeDJobState = 'queued' | 'running' | 'success' | 'failed'

interface ThreeDStatusResponse {
  id: string
  op?: string
  status: ThreeDJobState
  progress?: number
  model_url?: string
  model_urls?: string[]
  parts?: string[]
  riggable?: boolean
  rig_type?: string
  credits_consumed?: number
  billed_usd?: number
  error?: string
}

interface ProxyConfig {
  /** `${apiBase}/api/ai` — routes are appended as `/v1/...`. */
  base: string
  token: string
}

interface ModelTarget {
  absolute: string
  workspacePath: string
}

interface TrackedThreeDJob {
  id: string
  op: string
  prompt?: string
  model: string
  input: 'text' | 'image' | 'multiview' | 'model'
  /** Absent for part-only results (segment, rig check). */
  target?: ModelTarget
  status: ThreeDJobState
  progress?: number
  path?: string
  bytes?: number
  parts?: string[]
  riggable?: boolean
  creditsConsumed?: number
  billedUsd?: number
  error?: string
  /** Settles when the background follower finishes (saved, failed or gave up). */
  done?: Promise<void>
}

/** Jobs submitted from this runtime, so a later `generate_3d_model({ job_id })` knows where to save. */
const trackedThreeDJobs = new Map<string, TrackedThreeDJob>()

function proxyConfig(ctx: ToolContext): ProxyConfig | null {
  const url = ctx.aiProxyUrl || process.env.AI_PROXY_URL
  const token = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
  if (!url || !token) return null
  return { base: url.replace(/\/v1\/?$/, ''), token }
}

function toWorkspaceRelative(workspaceDir: string, absolutePath: string): string {
  return relative(resolve(workspaceDir), absolutePath).split(sep).join('/')
}

/** `a red fox sitting in a forest` → `a-red-fox-sitting`, for the default filename. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug.split('-').slice(0, 4).join('-') || 'model').slice(0, 48)
}

/**
 * Where a downloaded model lands. `path` may point anywhere in the workspace
 * (validated by `assertWithinWorkspace`); without it the file goes to
 * `models/` under the caller's filename. `ext` defaults to `.glb` and is
 * replaced when the caller's path already carries an extension.
 */
function resolveModelTarget(
  ctx: ToolContext,
  opts: { path?: string; filename: string; ext?: string },
): ModelTarget {
  const ext = (opts.ext || '.glb').startsWith('.') ? opts.ext || '.glb' : `.${opts.ext}`
  let absolute: string
  if (opts.path) {
    absolute = assertWithinWorkspace(ctx.workspaceDir, opts.path)
    if (absolute === resolve(ctx.workspaceDir)) throw new Error('path must name a file, not the workspace root.')
    if (!extname(absolute)) absolute = `${absolute}${ext}`
  } else {
    const safe = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    absolute = resolve(ctx.workspaceDir, 'models', safe.endsWith(ext) ? safe : `${safe}${ext}`)
  }
  mkdirSync(dirname(absolute), { recursive: true })
  return { absolute, workspacePath: toWorkspaceRelative(ctx.workspaceDir, absolute) }
}

/** The proxy accepts a data URI for image-to-model and uploads it upstream itself. */
function loadWorkspaceImageDataUri(ctx: ToolContext, workspacePath: string): { dataUri: string } | { error: string } {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `Image not found: ${workspacePath}` }
  const mimeType = IMAGE_MIME_BY_EXT[extname(resolved).toLowerCase()] || 'image/png'
  return { dataUri: `data:${mimeType};base64,${readFileSync(resolved).toString('base64')}` }
}

/** Content types for the model files a caller may import or convert. */
const MODEL_MIME_BY_EXT: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
  '.stl': 'application/octet-stream',
  '.3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  '.usdz': 'model/vnd.usdz+zip',
  '.zip': 'application/zip',
}

/**
 * Upload a workspace file to the proxy's `/3d/files` and return its
 * `file_token`. The JSON route caps at 25 MB, so anything larger is reported
 * with the limit rather than a generic failure.
 */
async function uploadWorkspaceFile(
  ctx: ToolContext,
  proxy: ProxyConfig,
  workspacePath: string,
  signal?: AbortSignal,
): Promise<{ fileToken: string } | { error: string }> {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `File not found: ${workspacePath}` }
  const bytes = readFileSync(resolved)
  if (bytes.length > 25 * 1024 * 1024) {
    return { error: `${workspacePath} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; uploads through the proxy are capped at 25MB.` }
  }
  const ext = extname(resolved).toLowerCase()
  const contentType = IMAGE_MIME_BY_EXT[ext] || MODEL_MIME_BY_EXT[ext] || 'application/octet-stream'
  const response = await fetch(`${proxy.base}/v1/3d/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
    body: JSON.stringify({
      filename: resolved.split('/').pop(),
      contentType,
      data_base64: bytes.toString('base64'),
    }),
    signal,
  })
  if (!response.ok) return { error: errorFromBody(response.status, await response.text()) }
  const data = (await response.json()) as { file_token?: string }
  return data.file_token ? { fileToken: data.file_token } : { error: 'The proxy accepted the upload but returned no file token.' }
}

/** Task id, file token, https URL or data URI — anything the proxy can forward as-is. */
function forwardsAsInput(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^file_[A-Za-z0-9]+$/.test(value) ||
    /^gen3d_/.test(value) ||
    /^https:\/\/\S+$/i.test(value) ||
    value.startsWith('data:')
  )
}

/** Short, actionable message instead of a raw proxy error body. */
function errorFromBody(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // Not JSON — fall through.
  }
  if (status === 402) return 'This project is out of usage credit, so no 3D model was generated. Add credit and try again.'
  if (status === 503) return '3D generation is temporarily unavailable (HTTP 503). Try again in a minute.'
  return `3D generation failed (HTTP ${status}).`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchThreeDStatus(proxy: ProxyConfig, id: string, signal?: AbortSignal): Promise<ThreeDStatusResponse> {
  const response = await fetch(`${proxy.base}/v1/3d/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${proxy.token}` },
    signal,
  })
  if (!response.ok) throw new Error(errorFromBody(response.status, await response.text()))
  return (await response.json()) as ThreeDStatusResponse
}

/**
 * Download and write the model file. `model_url` is a signed vendor URL that
 * expires after ~5 minutes, so this runs the moment the job reports success.
 * Part-producing ops (`segment`, `rig_check`) carry no file.
 */
async function saveResult(job: TrackedThreeDJob, status: ThreeDStatusResponse, signal?: AbortSignal): Promise<void> {
  job.creditsConsumed = status.credits_consumed
  job.billedUsd = status.billed_usd
  job.progress = 100

  if (!status.model_url) {
    if (!status.parts && status.riggable === undefined) {
      throw new Error('The proxy reported success but returned no model_url and no parts.')
    }
    job.status = 'success'
    job.parts = status.parts
    job.riggable = status.riggable
    return
  }

  const response = await fetch(status.model_url, { signal })
  if (!response.ok) throw new Error(`Model download failed (${response.status}); the URL expires after about 5 minutes.`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!job.target) throw new Error('No output path was planned for this job.')
  writeFileSync(job.target.absolute, buffer)
  job.status = 'success'
  job.path = job.target.workspacePath
  job.bytes = buffer.length
  job.parts = status.parts
  job.riggable = status.riggable
}

/**
 * Poll until the job settles, saving the file on completion. Returns false
 * when `deadline` passes first (the job is still running upstream).
 */
async function followThreeDJob(proxy: ProxyConfig, job: TrackedThreeDJob, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (true) {
    const status = await fetchThreeDStatus(proxy, job.id, signal)
    if (status.status === 'success') {
      await saveResult(job, status, signal)
      return true
    }
    if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || '3D generation failed'
      if (status.credits_consumed !== undefined) job.creditsConsumed = status.credits_consumed
      return true
    }
    job.status = status.status
    job.progress = status.progress
    if (Date.now() + THREE_D_POLL.intervalMs > deadline) return false
    await sleep(THREE_D_POLL.intervalMs, signal)
  }
}

/** Keep following a job after the tool call returns, so the file (and the charge) still lands. */
function followInBackground(proxy: ProxyConfig, job: TrackedThreeDJob): void {
  if (job.done) return
  const deadline = Date.now() + 60 * 60_000
  job.done = followThreeDJob(proxy, job, deadline)
    .then((settled) => {
      if (!settled) {
        job.status = 'failed'
        job.error = 'Gave up waiting for the model after an hour.'
      }
    })
    .catch((err) => {
      job.status = 'failed'
      job.error = err?.message || String(err)
      console.error(`[generate_3d_model] background job ${job.id} failed:`, job.error)
    })
}

/** One line the agent can quote to the user about what the task cost. */
function costLine(job: TrackedThreeDJob): string | undefined {
  if (job.billedUsd !== undefined) {
    const credits = job.creditsConsumed !== undefined ? ` (${job.creditsConsumed} Tripo credits)` : ''
    return `Billed $${job.billedUsd.toFixed(2)}${credits}.`
  }
  if (job.creditsConsumed !== undefined) {
    return `${job.creditsConsumed} Tripo credits consumed (100 credits = $1.00 of provider usage, billed at cost plus Shogo's markup).`
  }
  return undefined
}

/** True once a finished job is known to have consumed nothing. */
function isFree(job: TrackedThreeDJob): boolean {
  return job.status === 'success' && (job.creditsConsumed ?? 0) === 0
}

function jobResult(job: TrackedThreeDJob, extra: Record<string, unknown> = {}) {
  return textResult({
    id: job.id,
    op: job.op,
    status: job.status,
    path: job.path,
    paths: job.path ? [job.path] : undefined,
    model: job.model,
    input: job.input,
    prompt: job.prompt,
    progress: job.progress,
    parts: job.parts,
    riggable: job.riggable,
    credits_consumed: job.creditsConsumed,
    billed_usd: job.billedUsd,
    free: isFree(job) ? true : undefined,
    bytes: job.bytes,
    error: job.error,
    cost: isFree(job) ? 'This task was free (0 Tripo credits), so nothing was billed.' : costLine(job),
    ...extra,
  })
}

export function createGenerate3DModelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_3d_model',
    description:
      'Generate a 3D model (GLB) from a text prompt, a single still image ("image to 3D"), or four multiview images (front, left, back, right). ' +
      'Saves to models/ by default; pass path to save anywhere in the workspace. ' +
      'Billed per task — roughly $0.12-$0.60 depending on model and texture quality — so call list_media_models first to choose a model and budget. ' +
      'Text-to-3D takes under a minute, sometimes two. Pass wait: false to queue several, then call generate_3d_model({ job_id }) to check each one. ' +
      'For anything on an existing model (re-texture, convert, retopology, segment, rig, animate), use edit_3d_model instead.',
    label: 'Generate 3D Model',
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('multiview')], {
          description: 'How to build the model. Defaults from what you pass: prompt → text, image → image, images → multiview.',
        }),
      ),
      prompt: Type.Optional(
        Type.String({ description: 'What to build: subject, shape, style (e.g. "a low-poly red fox, game asset")' }),
      ),
      image: Type.Optional(
        Type.String({
          description: 'Workspace image path for image-to-3D (e.g. "refs/chair.png"). Pass prompt OR image, not both.',
        }),
      ),
      images: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 4,
          maxItems: 4,
          description:
            'Exactly 4 workspace image paths or https URLs for multiview-to-3D, in the order front, left, back, right.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: `3D model id (default "${THREE_D_DEFAULT_MODEL}"). Call list_media_models for ids and per-task prices: H-series ("tripo-v3.1") is cheaper, P-series ("tripo-p…") costs more and holds more detail.`,
        }),
      ),
      texture: Type.Optional(Type.Boolean({ description: 'Generate a texture for the mesh (default: model-dependent). Costs extra.' })),
      texture_quality: Type.Optional(
        Type.Union([Type.Literal('standard'), Type.Literal('detailed'), Type.Literal('extreme')], {
          description: 'Texture detail when texture is on; each step costs more credits.',
        }),
      ),
      face_limit: Type.Optional(
        Type.Integer({ minimum: 1000, maximum: 200000, description: 'Maximum triangle count for the mesh (lower = lighter file)' }),
      ),
      path: Type.Optional(
        Type.String({ description: 'Output path anywhere in the workspace (e.g. "public/assets/fox.glb"). "models/" is the default.' }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: 'Wait for the model to finish (default true). false returns a job_id immediately.' }),
      ),
      job_id: Type.Optional(
        Type.String({ description: 'Check (and save, once finished) a job started earlier with wait: false' }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        mode?: 'text' | 'image' | 'multiview'
        prompt?: string
        image?: string
        images?: string[]
        model?: string
        texture?: boolean
        texture_quality?: 'standard' | 'detailed' | 'extreme'
        face_limit?: number
        path?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: '3D generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkThreeDJob(ctx, proxy, p.job_id, p, signal)

      const hasPrompt = typeof p.prompt === 'string' && p.prompt.trim().length > 0
      const hasImage = typeof p.image === 'string' && p.image.length > 0
      const hasImages = Array.isArray(p.images) && p.images.length > 0
      const given = [hasPrompt, hasImage, hasImages].filter(Boolean).length
      if (given > 1) {
        return textResult({
          error: 'Pass one of prompt, image or images: a prompt builds from text, an image from a still, four images from multiviews.',
        })
      }
      if (given === 0) {
        return textResult({
          error:
            'prompt is required to generate a 3D model. Pass image for image-to-3D, images (4) for multiview, or job_id to check an earlier job.',
        })
      }
      if (p.mode && ((p.mode === 'text' && !hasPrompt) || (p.mode === 'image' && !hasImage) || (p.mode === 'multiview' && !hasImages))) {
        return textResult({ error: `mode "${p.mode}" needs ${p.mode === 'multiview' ? '4 images' : p.mode === 'image' ? 'an image' : 'a prompt'}.` })
      }
      if (hasImages && p.images!.length !== 4) {
        return textResult({ error: `Multiview-to-3D needs exactly 4 images in the order front, left, back, right; got ${p.images!.length}.` })
      }

      const op = hasImages ? 'multiview_to_model' : hasImage ? 'image_to_model' : 'text_to_model'

      let image: string | undefined
      if (hasImage) {
        try {
          const loaded = loadWorkspaceImageDataUri(ctx, p.image!)
          if ('error' in loaded) return textResult({ error: loaded.error })
          image = loaded.dataUri
        } catch (err: any) {
          return textResult({ error: err.message })
        }
      }

      // Each view is either a workspace image (as a data URI the proxy uploads)
      // or an https URL it forwards untouched.
      let views: string[] | undefined
      if (hasImages) {
        views = []
        for (const view of p.images!) {
          if (/^https:\/\/\S+$/i.test(view)) {
            views.push(view)
            continue
          }
          try {
            const loaded = loadWorkspaceImageDataUri(ctx, view)
            if ('error' in loaded) return textResult({ error: loaded.error })
            views.push(loaded.dataUri)
          } catch (err: any) {
            return textResult({ error: err.message })
          }
        }
      }

      let submitted: { id: string; status?: ThreeDJobState; op?: string; model: string; estimated_usd?: number }
      try {
        const response = await fetch(`${proxy.base}/v1/3d/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({
            op,
            prompt: hasPrompt ? p.prompt : undefined,
            image,
            images: views,
            model: p.model,
            texture: p.texture,
            texture_quality: p.texture_quality,
            face_limit: p.face_limit,
          }),
          signal,
        })
        if (!response.ok) {
          return textResult({ error: errorFromBody(response.status, await response.text()) })
        }
        submitted = (await response.json()) as typeof submitted
      } catch (err: any) {
        return textResult({ error: `3D generation error: ${err.message}` })
      }

      let target: ModelTarget
      try {
        const stemSource = p.prompt || (p.image ? p.image.split('/').pop() || 'model' : 'multiview')
        const stem = `${slugify(stemSource)}-${submitted.id.replace(/^gen3d_/, '')}`
        target = resolveModelTarget(ctx, { path: p.path, filename: stem })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const job: TrackedThreeDJob = {
        id: submitted.id,
        op: submitted.op || op,
        prompt: p.prompt,
        model: submitted.model || p.model || THREE_D_DEFAULT_MODEL,
        input: hasImages ? 'multiview' : hasImage ? 'image' : 'text',
        target,
        status: 'queued',
      }
      trackedThreeDJobs.set(job.id, job)
      const planned = target.workspacePath

      if (p.wait === false) {
        followInBackground(proxy, job)
        return jobResult(job, {
          job_id: job.id,
          planned_path: planned,
          estimated_usd: submitted.estimated_usd,
          message: `Queued. The model will be saved to ${planned} when it finishes; call generate_3d_model({ job_id: "${job.id}" }) to check.`,
        })
      }

      try {
        const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, signal)
        if (!settled) {
          followInBackground(proxy, job)
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            estimated_usd: submitted.estimated_usd,
            message: `Still generating after ${Math.round(THREE_D_POLL.timeoutMs / 60_000)} minutes. It will be saved to ${planned} when it finishes; call generate_3d_model({ job_id: "${job.id}" }) to check.`,
          })
        }
        return jobResult(job, { estimated_usd: submitted.estimated_usd })
      } catch (err: any) {
        // The task keeps running upstream; keep following it so the file still lands.
        followInBackground(proxy, job)
        if (signal?.aborted) {
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            message: `Stopped waiting. The model is still generating and will be saved to ${planned}.`,
          })
        }
        return jobResult(job, { error: `3D generation error: ${err.message}`, job_id: job.id })
      }
    },
  }
}

async function checkThreeDJob(
  ctx: ToolContext,
  proxy: ProxyConfig,
  id: string,
  p: { path?: string; wait?: boolean },
  signal?: AbortSignal,
) {
  try {
    let job = trackedThreeDJobs.get(id)
    if (!job) {
      // Submitted elsewhere (another process, or before a restart): save where
      // the caller says, falling back to models/.
      job = {
        id,
        op: 'text_to_model',
        model: THREE_D_DEFAULT_MODEL,
        input: 'text',
        target: resolveModelTarget(ctx, { path: p.path, filename: `model-${id.replace(/^gen3d_/, '')}` }),
        status: 'queued',
      }
      trackedThreeDJobs.set(id, job)
    }
    if (job.status === 'success' || job.status === 'failed') return jobResult(job)

    if (p.wait === true) {
      const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, signal)
      if (!settled) followInBackground(proxy, job)
      return jobResult(job)
    }

    const status = await fetchThreeDStatus(proxy, id, signal)
    job.progress = status.progress
    if (status.status === 'success') {
      await saveResult(job, status, signal)
    } else if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || '3D generation failed'
      if (status.credits_consumed !== undefined) job.creditsConsumed = status.credits_consumed
    } else {
      job.status = status.status
      // The background follower finishes the download even if the job outlasts this turn.
      followInBackground(proxy, job)
    }
    return jobResult(job)
  } catch (err: any) {
    return textResult({ id, error: `3D status check failed: ${err.message}` })
  }
}

/**
 * Post-process an existing model: re-texture, convert, decimate, segment,
 * complete, rig, animate, or import an outside model. One entry point per
 * intent, with the operation as a parameter — `input` is a `gen3d_…` job id,
 * a vendor task id, a workspace file, or an https URL.
 */
export function createEdit3DModelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'edit_3d_model',
    description:
      'Run an operation on an existing 3D model and save the result. ops: ' +
      'texture (new texture from a prompt and/or style image), convert (export as GLTF, FBX, USDZ, OBJ, STL or 3MF), ' +
      'retopology (lower the triangle count), segment (split into named parts), complete (fill in missing parts), ' +
      'rig_check (free check of whether the model can be rigged), rig (add a skeleton), retarget (apply animation presets), ' +
      'import (ingest an outside GLB/GLTF/FBX/OBJ/STL). ' +
      'input is the job id from generate_3d_model, a workspace model path, or an https URL. ' +
      'Billed per task (~$0.10-$0.60, convert ~$0.12, rig_check free), so call list_media_models for op prices first. ' +
      'Pass wait: false to queue, then call edit_3d_model({ job_id }) to check.',
    label: 'Edit 3D Model',
    parameters: Type.Object({
      op: Type.Union(
        EDIT_3D_OPS.map((op) => Type.Literal(op)),
        {
          description:
            'Operation to run. segment returns part names for complete; rig_check is free; convert needs format.',
        },
      ),
      input: Type.Optional(
        Type.String({
          description:
            'The model to work on: a job id from generate_3d_model (gen3d_…), a workspace path (e.g. "models/chest.glb"), or an https URL. Omit when checking a job_id.',
        }),
      ),
      format: Type.Optional(
        Type.Union(
          ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'].map((f) => Type.Literal(f)),
          { description: 'convert only: output format.' },
        ),
      ),
      texture_prompt: Type.Optional(
        Type.String({ description: 'texture only: what the new surface should look like (e.g. "weathered oak planks").' }),
      ),
      style_image: Type.Optional(
        Type.String({ description: 'texture only: workspace image to use as the style reference.' }),
      ),
      texture_quality: Type.Optional(
        Type.Union([Type.Literal('standard'), Type.Literal('detailed'), Type.Literal('extreme')], {
          description: 'texture only: detail tier; each step costs more credits.',
        }),
      ),
      face_limit: Type.Optional(
        Type.Integer({ minimum: 500, maximum: 200000, description: 'retopology only: target triangle count.' }),
      ),
      part_names: Type.Optional(
        Type.Array(Type.String(), {
          description: 'complete/retopology/texture: part names returned by segment when the op should target specific parts.',
        }),
      ),
      rig_type: Type.Optional(
        Type.String({ description: 'rig only: skeleton preset (default "biped").' }),
      ),
      animation: Type.Optional(
        Type.String({ description: 'retarget only: one animation preset id (e.g. "preset:walk").' }),
      ),
      animations: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 5,
          description: 'retarget only: up to 5 animation preset ids. Pass this or animation, not both.',
        }),
      ),
      path: Type.Optional(
        Type.String({ description: 'Output path anywhere in the workspace. "models/" is the default.' }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: 'Wait for the result (default true). false returns a job_id immediately.' }),
      ),
      job_id: Type.Optional(
        Type.String({ description: 'Check (and save, once finished) a job started earlier with wait: false.' }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        op?: string
        input?: string
        format?: string
        texture_prompt?: string
        style_image?: string
        texture_quality?: 'standard' | 'detailed' | 'extreme'
        face_limit?: number
        part_names?: string[]
        rig_type?: string
        animation?: string
        animations?: string[]
        path?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: '3D generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkThreeDJob(ctx, proxy, p.job_id, p, signal)

      // `rig-check` from the CLI and `rig_check` from the tool are the same op.
      const op = (p.op || '').replace(/-/g, '_') as Edit3DOp
      if (!EDIT_3D_OPS.includes(op)) {
        return textResult({ error: `op is required and must be one of ${EDIT_3D_OPS.join(', ')}.` })
      }
      const input = typeof p.input === 'string' ? p.input.trim() : ''
      if (!input) return textResult({ error: `input is required for ${op}: a job id, a workspace model path, or an https URL.` })

      const body: Record<string, unknown> = { op }

      if (op === 'convert') {
        const format = (p.format || '').toUpperCase()
        if (!EXT_BY_FORMAT[format]) {
          return textResult({ error: `format is required for convert and must be one of ${Object.keys(EXT_BY_FORMAT).join(', ')}.` })
        }
        body.format = format
      }
      if (op === 'texture') {
        if (p.style_image) {
          let styleImage: string
          if (/^https:\/\/\S+$/i.test(p.style_image)) {
            styleImage = p.style_image
          } else {
            const uploaded = await uploadWorkspaceFile(ctx, proxy, p.style_image, signal)
            if ('error' in uploaded) return textResult({ error: uploaded.error })
            styleImage = uploaded.fileToken
          }
          body.texture_prompt = {
            ...(p.texture_prompt ? { text: p.texture_prompt } : {}),
            style_image: styleImage,
          }
        } else if (p.texture_prompt) {
          body.texture_prompt = { text: p.texture_prompt }
        }
        if (p.texture_quality) body.texture_quality = p.texture_quality
        if (p.part_names?.length) body.part_names = p.part_names
      }
      if (op === 'retopology') {
        if (p.face_limit) body.face_limit = p.face_limit
        if (p.part_names?.length) body.part_names = p.part_names
      }
      if (op === 'segment' && p.part_names?.length) body.part_names = p.part_names
      if (op === 'complete') {
        if (!p.part_names?.length) {
          return textResult({ error: 'part_names is required for complete: run segment first and pass the parts to fill in.' })
        }
        body.part_names = p.part_names
      }
      if (op === 'rig') {
        body.rig_type = p.rig_type || 'biped'
      }
      if (op === 'retarget') {
        if (p.animation && p.animations?.length) {
          return textResult({ error: 'Pass either animation or animations, not both.' })
        }
        if (!p.animation && !p.animations?.length) {
          return textResult({ error: 'animation or animations is required for retarget (e.g. "preset:walk").' })
        }
        if (p.animations && (p.animations.length === 0 || p.animations.length > 5)) {
          return textResult({ error: `animations takes 1-5 presets; got ${p.animations.length}.` })
        }
        if (p.animation) body.animation = p.animation
        if (p.animations?.length) body.animations = p.animations
      }

      // A workspace file goes up through /3d/files; everything else is a handle
      // the proxy understands already.
      let resolvedInput = input
      if (!forwardsAsInput(input)) {
        const uploaded = await uploadWorkspaceFile(ctx, proxy, input, signal)
        if ('error' in uploaded) return textResult({ error: uploaded.error })
        resolvedInput = uploaded.fileToken
      }
      body.input = resolvedInput

      let submitted: { id: string; op?: string; status?: ThreeDJobState; model?: string; estimated_usd?: number }
      try {
        const response = await fetch(`${proxy.base}/v1/3d/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify(body),
          signal,
        })
        if (!response.ok) {
          return textResult({ error: errorFromBody(response.status, await response.text()) })
        }
        submitted = (await response.json()) as typeof submitted
      } catch (err: any) {
        return textResult({ error: `3D ${op} error: ${err.message}` })
      }

      const ext = op === 'convert' ? EXT_BY_FORMAT[String(body.format)] : '.glb'
      const partOnly = PART_OPS.has(op)
      let target: ModelTarget | undefined
      try {
        if (!partOnly) {
          const stemSource = input.replace(/^gen3d_/, '').split(/[\\/]/).pop() || op
          const stem = `${op}-${slugify(stemSource.replace(/\.[a-z0-9]+$/i, ''))}-${submitted.id.replace(/^gen3d_/, '')}`
          target = resolveModelTarget(ctx, { path: p.path, filename: stem, ext })
        }
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const job: TrackedThreeDJob = {
        id: submitted.id,
        op: submitted.op || op,
        model: op,
        input: 'model',
        target,
        status: 'queued',
      }
      trackedThreeDJobs.set(job.id, job)

      if (p.wait === false) {
        followInBackground(proxy, job)
        return jobResult(job, {
          job_id: job.id,
          planned_path: target?.workspacePath,
          estimated_usd: submitted.estimated_usd,
          message: `Queued ${op}. Call edit_3d_model({ job_id: "${job.id}" }) to check.`,
        })
      }

      try {
        const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, signal)
        if (!settled) {
          followInBackground(proxy, job)
          return jobResult(job, {
            job_id: job.id,
            planned_path: target?.workspacePath,
            estimated_usd: submitted.estimated_usd,
            message: `Still running after ${Math.round(THREE_D_POLL.timeoutMs / 60_000)} minutes. Call edit_3d_model({ job_id: "${job.id}" }) to check.`,
          })
        }
        return jobResult(job, {
          estimated_usd: submitted.estimated_usd,
          ...(op === 'rig_check' && isFree(job) ? { message: 'Rig check is free, so no credits were used.' } : {}),
        })
      } catch (err: any) {
        followInBackground(proxy, job)
        if (signal?.aborted) {
          return jobResult(job, {
            job_id: job.id,
            message: `Stopped waiting. The ${op} task is still running and the result will be saved when it finishes.`,
          })
        }
        return jobResult(job, { error: `3D ${op} error: ${err.message}`, job_id: job.id })
      }
    },
  }
}

/** 3D tools registered alongside the image/video tools (gating: `filterDisabledCapabilityTools`). */
export function createThreeDTools(ctx: ToolContext): AgentTool[] {
  return [createGenerate3DModelTool(ctx), createEdit3DModelTool(ctx)]
}

/** Test seam. */
export const _testing = { trackedThreeDJobs }
