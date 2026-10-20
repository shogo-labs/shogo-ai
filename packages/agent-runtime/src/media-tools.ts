// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Media tools: image generation and editing, video generation, and the
 * model/price listing the agent uses to choose between them. Every call goes
 * through the AI proxy (`/ai/v1/images/*`, `/ai/v1/videos/*`,
 * `/ai/v1/media/models`), which owns provider keys and billing.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve, extname, dirname, relative, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { assertWithinWorkspace } from './permission-engine'
import { createThreeDTools } from './three-d-tools'

export { IMAGE_TOOL_NAMES, VIDEO_TOOL_NAMES, THREE_D_TOOL_NAMES, MEDIA_TOOL_NAMES } from './media-tool-names'

/** Upper bound on reference images a tool call may attach; models may allow fewer (see list_media_models). */
export const MAX_REFERENCE_IMAGES = 4

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

export function extensionForContentType(contentType: string | undefined, fallback: string): string {
  if (!contentType) return fallback
  return EXT_BY_CONTENT_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? fallback
}

interface ProxyConfig {
  /** `${apiBase}/api/ai` — routes are appended as `/v1/...`. */
  base: string
  token: string
}

function proxyConfig(ctx: ToolContext): ProxyConfig | null {
  const url = ctx.aiProxyUrl || process.env.AI_PROXY_URL
  const token = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
  if (!url || !token) return null
  return { base: url.replace(/\/v1\/?$/, ''), token }
}

function toWorkspaceRelative(workspaceDir: string, absolutePath: string): string {
  return relative(resolve(workspaceDir), absolutePath).split(sep).join('/')
}

interface LoadedImage {
  workspacePath: string
  buffer: Buffer
  mimeType: string
  ext: string
}

function loadWorkspaceImage(ctx: ToolContext, workspacePath: string): LoadedImage | { error: string } {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `Reference image not found: ${workspacePath}` }
  const ext = extname(resolved).toLowerCase()
  return {
    workspacePath,
    buffer: readFileSync(resolved),
    mimeType: IMAGE_MIME_BY_EXT[ext] || 'image/png',
    ext: ext || '.png',
  }
}

function toDataUri(image: LoadedImage): string {
  return `data:${image.mimeType};base64,${image.buffer.toString('base64')}`
}

/** Higgsfield's input limit for a Genjutsu source clip. */
export const MAX_SOURCE_VIDEO_BYTES = 200 * 1024 * 1024

/**
 * Duration of an MP4, read from its `mvhd` box — the only reliable way to know
 * how many source seconds a Genjutsu edit will be billed for without shelling
 * out to ffprobe. Returns null when the box can't be read (fragmented or
 * non-standard files), and the caller then refuses the edit.
 */
export function readMp4DurationSeconds(buffer: Buffer): number | null {
  const findBox = (type: string, from: number, to: number): { payload: number; end: number } | null => {
    let offset = from
    while (offset + 8 <= to) {
      const size = buffer.readUInt32BE(offset)
      if (size < 8) return null
      const kind = buffer.toString('ascii', offset + 4, offset + 8)
      const end = Math.min(offset + size, to)
      if (kind === type) return { payload: offset + 8, end }
      offset = end
    }
    return null
  }

  const moov = findBox('moov', 0, buffer.length)
  if (!moov) return null
  const mvhd = findBox('mvhd', moov.payload, moov.end)
  if (!mvhd) return null

  const version = buffer[mvhd.payload]
  const timescale = version === 1
    ? buffer.readUInt32BE(mvhd.payload + 20)
    : buffer.readUInt32BE(mvhd.payload + 12)
  const duration = version === 1
    ? Number(buffer.readBigUInt64BE(mvhd.payload + 24))
    : buffer.readUInt32BE(mvhd.payload + 16)
  if (!timescale || !duration) return null
  const seconds = duration / timescale
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Read a workspace clip for a Genjutsu edit. Only MP4 is accepted (the provider
 * documents `video/mp4`), the size is checked before anything is uploaded, and
 * the duration is measured because the edit is billed per source second.
 */
function loadWorkspaceVideo(
  ctx: ToolContext,
  workspacePath: string,
  maxBytes = MAX_SOURCE_VIDEO_BYTES,
): { buffer: Buffer; workspacePath: string; durationSeconds: number } | { error: string } {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `Source video not found: ${workspacePath}` }
  if (extname(resolved).toLowerCase() !== '.mp4') {
    return { error: `Source video must be an .mp4 (got ${extname(resolved) || 'no extension'}): ${workspacePath}` }
  }
  const buffer = readFileSync(resolved)
  if (buffer.byteLength > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024))
    const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(1)
    return { error: `Source video is ${sizeMb} MB; the limit is ${limitMb} MB. Trim or compress it first.` }
  }
  const durationSeconds = readMp4DurationSeconds(buffer)
  if (durationSeconds === null) {
    return { error: `Could not read the duration of ${workspacePath}. Re-export it as a standard MP4 (H.264) and try again.` }
  }
  if (durationSeconds < 4) {
    return { error: `Source video is ${durationSeconds.toFixed(1)} s; Genjutsu needs at least 4 s.` }
  }
  return { buffer, workspacePath, durationSeconds }
}

/**
 * Put a workspace clip on the provider's storage and return its public URL.
 * The proxy owns the provider key, so the bytes go through it rather than to
 * the storage host directly.
 */
async function uploadSourceVideo(
  proxy: ProxyConfig,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<{ url: string } | { error: string }> {
  const response = await fetch(`${proxy.base}/v1/media/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', Authorization: `Bearer ${proxy.token}` },
    body: buffer as unknown as BodyInit,
    signal,
  })
  if (!response.ok) {
    return { error: friendlyMediaError('Uploading the source video', response.status, await response.text()) }
  }
  const body = (await response.json()) as { url?: string }
  if (!body.url) return { error: 'Uploading the source video failed: the proxy returned no URL.' }
  return { url: body.url }
}

/**
 * Where generated media lands. `path` may point anywhere in the workspace
 * (validated by `assertWithinWorkspace`); `filename` is a shortcut that
 * stays inside `defaultDir`; neither means an auto-generated name in
 * `defaultDir`. When `count > 1` the files get `-1`, `-2`, … suffixes.
 * The extension comes from the caller's name when given, otherwise from the
 * provider's content type at write time.
 */
export interface OutputTarget {
  pathFor(index: number, count: number, contentType: string | undefined): { absolute: string; workspacePath: string }
}

export function resolveOutputTarget(
  ctx: ToolContext,
  opts: { path?: string; filename?: string; defaultDir: string; prefix: string; defaultExt: string },
): OutputTarget {
  let dir: string
  let stem: string
  let explicitExt: string | undefined

  if (opts.path) {
    const absolute = assertWithinWorkspace(ctx.workspaceDir, opts.path)
    if (absolute === resolve(ctx.workspaceDir)) throw new Error('path must name a file, not the workspace root.')
    dir = dirname(absolute)
    const base = absolute.slice(dir.length + 1)
    explicitExt = extname(base) || undefined
    stem = explicitExt ? base.slice(0, -explicitExt.length) : base
  } else {
    dir = join(ctx.workspaceDir, opts.defaultDir)
    if (opts.filename) {
      const safe = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      explicitExt = extname(safe) || undefined
      stem = (explicitExt ? safe.slice(0, -explicitExt.length) : safe) || opts.prefix
    } else {
      stem = `${opts.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }
  }
  const resolvedDir = resolve(dir)
  mkdirSync(resolvedDir, { recursive: true })

  return {
    pathFor(index, count, contentType) {
      const ext = explicitExt ?? extensionForContentType(contentType, opts.defaultExt)
      const name = count === 1 ? `${stem}${ext}` : `${stem}-${index + 1}${ext}`
      const absolute = resolve(resolvedDir, name)
      if (dirname(absolute) !== resolvedDir) throw new Error('Invalid filename: path traversal detected.')
      return { absolute, workspacePath: toWorkspaceRelative(ctx.workspaceDir, absolute) }
    },
  }
}

/** Collects `reference_images` plus the legacy single `reference_image` alias, de-duplicated. */
function referencePaths(params: { reference_images?: string[]; reference_image?: string }): string[] {
  const all = [...(params.reference_images ?? []), ...(params.reference_image ? [params.reference_image] : [])]
  return [...new Set(all.filter((p) => typeof p === 'string' && p.length > 0))]
}

/**
 * Turn a raw upstream media failure into a short, human-readable message
 * instead of surfacing the raw (sometimes doubly-JSON-nested) provider error
 * body straight into the chat transcript — e.g. the proxy wraps an OpenAI
 * failure as a string like `OpenAI image generation error (400):
 * {"error":{"message":"Unknown parameter: 'response_format'."}}`, which
 * GenerateImageWidget (apps/mobile) used to render verbatim. The raw text is
 * still logged server-side (agent-runtime process stdout) for debugging.
 */
export function friendlyMediaError(context: string, status: number, rawErrorText: string): string {
  console.error(`[${context}] upstream error (${status}):`, rawErrorText)
  try {
    const parsed = JSON.parse(rawErrorText)
    let message: string | undefined = parsed?.error?.message
    if (typeof message === 'string') {
      // Unwrap one more level of nested JSON, if the proxy embedded it in
      // the message text (see the doc comment above).
      const nestedMatch = message.match(/:\s*(\{[\s\S]*\})\s*$/)
      if (nestedMatch) {
        try {
          const nested = JSON.parse(nestedMatch[1])
          if (typeof nested?.error?.message === 'string') message = nested.error.message
        } catch {
          // Keep the outer message — the embedded text wasn't valid JSON.
        }
      }
      if (message) return message
    }
  } catch {
    // Not JSON at all — fall through to the generic message below.
  }
  if (status === 429) return `${context} is rate-limited right now. Please try again in a moment.`
  if (status >= 500) return `The media provider is temporarily unavailable. Please try again shortly.`
  return `${context} failed. Please try a different prompt.`
}

// ---------------------------------------------------------------------------
// generate_image
// ---------------------------------------------------------------------------

const IMAGE_MODEL_GUIDE =
  'Image model id. Omit it to use the workspace default (SOUL V2 on Higgsfield; gpt-image-2.5-flare when only OpenAI is configured). Call list_media_models for the full list with prices. ' +
  'Rough guide: "hf-soul-v2" for general editorial/product images, "hf-ideogram-4" for text in images (posters, logos), ' +
  '"hf-marketing-studio-flare" for ad creative, "gpt-image-2.5-flare"/"gpt-image-2" for OpenAI prompt following. ' +
  'Every Higgsfield model accepts model-specific fields through `options`; list_media_models shows them.'

export function createGenerateImageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_image',
    description:
      'Generate one to four image options from a text prompt (default model hf-soul-v2 on Higgsfield). Pass reference_images (workspace paths) to edit an image or to keep a character, product or style consistent across shots. ' +
      'Saves to images/ by default; pass path to save anywhere in the workspace (e.g. "public/assets/hero.png").',
    label: 'Generate Image',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Text description of the image to generate, or the edit instruction when passing reference images',
      }),
      path: Type.Optional(
        Type.String({
          description:
            'Output path anywhere in the workspace (e.g. "public/assets/cab1/player.png"). With options > 1 the files get -1, -2, … suffixes. Overrides filename.',
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description: 'Destination filename under images/ (default: auto-generated). Ignored when path is set.',
        }),
      ),
      size: Type.Optional(
        Type.String({
          description:
            'Image size: "1024x1024", "1024x1792" (portrait), "1792x1024" (landscape), or another WxH (default: "1024x1024"). Non-OpenAI models use the closest aspect ratio.',
        }),
      ),
      options: Type.Optional(
        Type.Union(
          [
            Type.Integer({ minimum: 1, maximum: 4, description: 'Number of image options to generate (1-4, default: 1)' }),
            Type.Object({}, {
              additionalProperties: true,
              description:
                'Model-specific documented fields for the chosen model (e.g. { "seed": 42, "negative_prompt": "blurry" }). list_media_models lists each model\'s fields with their allowed values. Omit for defaults.',
            }),
          ],
          {
            description: 'Either the number of image options (1-4) or an object of model-specific fields.',
          },
        ),
      ),
      // OpenAI retired the DALL-E 2/3 models (2026-09) — "dall-e-3" now 400s
      // with "The model 'dall-e-3' does not exist."
      model: Type.Optional(Type.String({ description: IMAGE_MODEL_GUIDE })),
      quality: Type.Optional(
        Type.String({
          description: 'Image quality: "standard" or "hd" (default: "standard"). hd costs more on some models.',
        }),
      ),
      reference_images: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: MAX_REFERENCE_IMAGES,
          description: `Up to ${MAX_REFERENCE_IMAGES} workspace image paths to edit or to use as character/style references (e.g. ["brand/hero.png", "refs/pose.png"]). Not every model accepts references; see list_media_models.`,
        }),
      ),
      reference_image: Type.Optional(
        Type.String({
          description: 'Single reference image path; shorthand for reference_images with one entry.',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        prompt: string
        path?: string
        filename?: string
        size?: string
        model?: string
        quality?: string
        reference_images?: string[]
        reference_image?: string
        options?: number | Record<string, unknown>
      }
      // With no explicit model the proxy picks the workspace's configured
      // default provider (Higgsfield when its key is set, OpenAI otherwise), so
      // a Higgsfield-less install still works instead of 503-ing.
      const { prompt, size = '1024x1024', model, quality = 'standard' } = p
      const modelOptions = typeof p.options === 'object' && p.options !== null ? p.options : undefined
      const options = typeof p.options === 'number' ? p.options : 1

      if (!Number.isInteger(options) || options < 1 || options > 4) {
        return textResult({ error: 'The options parameter must be an integer between 1 and 4.' })
      }

      const refs = referencePaths(p)
      if (refs.length > MAX_REFERENCE_IMAGES) {
        return textResult({ error: `At most ${MAX_REFERENCE_IMAGES} reference images are supported per call.` })
      }

      const proxy = proxyConfig(ctx)
      if (!proxy) {
        return textResult({ error: 'Image generation is not available: AI proxy not configured.' })
      }

      let target: OutputTarget
      try {
        target = resolveOutputTarget(ctx, {
          path: p.path,
          filename: p.filename,
          defaultDir: 'images',
          prefix: 'generated',
          defaultExt: '.png',
        })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      try {
        const loaded: LoadedImage[] = []
        for (const ref of refs) {
          const image = loadWorkspaceImage(ctx, ref)
          if ('error' in image) return textResult({ error: image.error })
          loaded.push(image)
        }

        let response: Response
        if (loaded.length > 0) {
          const formData = new FormData()
          for (const [i, image] of loaded.entries()) {
            formData.append('image', new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }), `reference-${i + 1}${image.ext}`)
          }
          formData.append('prompt', prompt)
          if (model) formData.append('model', model)
          formData.append('size', size)
          formData.append('quality', quality)
          formData.append('n', String(options))
          if (modelOptions) formData.append('options', JSON.stringify(modelOptions))
          response = await fetch(`${proxy.base}/v1/images/edits`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${proxy.token}` },
            body: formData,
            signal,
          })
        } else {
          response = await fetch(`${proxy.base}/v1/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
            body: JSON.stringify({ prompt, model, size, quality, n: options, options: modelOptions }),
            signal,
          })
        }

        if (!response.ok) {
          const errText = await response.text()
          return textResult({
            error: friendlyMediaError(loaded.length > 0 ? 'Image edit' : 'Image generation', response.status, errText),
          })
        }

        const responseData = (await response.json()) as any
        if (responseData.error) {
          return textResult({ error: responseData.error.message || 'Image generation failed' })
        }

        const imageDataList = Array.isArray(responseData.data) ? responseData.data.slice(0, options) : []
        if (imageDataList.length === 0 || imageDataList.some((item: any) => !item?.b64_json)) {
          return textResult({ error: 'No image data received from provider' })
        }

        const paths: string[] = []
        const revisedPrompts: string[] = []
        let totalBytes = 0
        for (const [index, imageData] of imageDataList.entries()) {
          const imageBuffer = Buffer.from(imageData.b64_json, 'base64')
          const out = target.pathFor(index, imageDataList.length, imageData.content_type)
          writeFileSync(out.absolute, imageBuffer)
          paths.push(out.workspacePath)
          totalBytes += imageBuffer.length
          revisedPrompts.push(imageData.revised_prompt || prompt)
        }

        return textResult({
          path: paths[0],
          paths,
          size,
          model: responseData.model ?? model,
          quality,
          bytes: totalBytes,
          revised_prompt: revisedPrompts[0],
          revised_prompts: revisedPrompts,
          reference_image: refs[0],
          reference_images: refs.length > 0 ? refs : undefined,
        })
      } catch (err: any) {
        return textResult({ error: `Image generation error: ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// list_media_models
// ---------------------------------------------------------------------------

function createListMediaModelsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'list_media_models',
    description:
      'List the image, video and 3D models you can use: what each is best for, whether it accepts reference images or a start frame, its endpoints, every documented parameter (allowed values, ranges, defaults) and its Shogo price (per image, per second of video, or per clip). ' +
      'Pass model to see just that model — the best way to check which fields its `options` accepts before calling generate_image or generate_video. Check prices here before planning a batch so you can budget it.',
    label: 'List Media Models',
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('3d'), Type.Literal('presets'), Type.Literal('all')], {
          description: 'Which models to list (default: "all"); "presets" lists the Genjutsu Restyle style ids',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: 'Only this model (e.g. "hf-kling-3.0-std"), with its full option list. Retired ids resolve to the model that replaced them.',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { kind = 'all', model } = params as { kind?: 'image' | 'video' | '3d' | 'presets' | 'all'; model?: string }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: 'Media models are not available: AI proxy not configured.' })

      if (kind === 'presets') {
        // Restyle style ids change over time, so they are fetched live rather
        // than read from the catalog.
        try {
          const response = await fetch(`${proxy.base}/v1/media/presets`, {
            headers: { Authorization: `Bearer ${proxy.token}` },
            signal,
          })
          if (!response.ok) {
            return textResult({ error: friendlyMediaError('Listing restyle presets', response.status, await response.text()) })
          }
          const data = (await response.json()) as { presets?: unknown[] }
          return textResult({ presets: data.presets ?? [] })
        } catch (err: any) {
          return textResult({ error: `Listing restyle presets failed: ${err.message}` })
        }
      }

      try {
        const query = new URLSearchParams()
        if (model) query.set('model', model)
        if (kind === 'image' || kind === 'video') query.set('kind', kind)
        const suffix = query.size > 0 ? `?${query.toString()}` : ''
        const response = await fetch(`${proxy.base}/v1/media/models${suffix}`, {
          headers: { Authorization: `Bearer ${proxy.token}` },
          signal,
        })
        if (!response.ok) {
          return textResult({ error: friendlyMediaError('Listing media models', response.status, await response.text()) })
        }
        const data = (await response.json()) as { images?: unknown[]; videos?: unknown[]; currency?: string; note?: string }
        const imageOn = ctx.config?.imageGenEnabled !== false
        const videoOn = ctx.config?.videoGenEnabled === true
        const threeDOn = ctx.config?.threeDGenEnabled === true
        const showImages = kind === 'all' || kind === 'image'
        const showVideos = kind === 'all' || kind === 'video'
        const show3d = kind === 'all' || kind === '3d'
        // 3D models come from their own route, and only when the capability is on:
        // each task is billed, so there is no point advertising them otherwise.
        const models3d = threeDOn && show3d ? await fetchThreeDModels(proxy, signal) : undefined
        const images = data.images ?? []
        const videos = data.videos ?? []
        return textResult({
          ...(showImages && imageOn ? { images } : {}),
          ...(showVideos
            ? videoOn
              ? { videos }
              : { videos: [], videos_note: 'Video generation is off for this project. The user can enable it in Capabilities.' }
            : {}),
          ...(models3d ?? {}),
          ...(model && images.length === 0 && videos.length === 0 && (kind === 'all' || kind === 'image' || kind === 'video')
            ? { note: `No model matches '${model}'. Call list_media_models without model for the full list.` }
            : {}),
          currency: data.currency ?? 'USD',
          note: data.note,
        })
      } catch (err: any) {
        return textResult({ error: `Listing media models failed: ${err.message}` })
      }
    },
  }
}

/** `models_3d`, or a note explaining why the 3D list is empty. */
async function fetchThreeDModels(
  proxy: ProxyConfig,
  signal?: AbortSignal,
): Promise<{ models_3d: unknown[] } | { models_3d: unknown[]; models_3d_note: string }> {
  try {
    const response = await fetch(`${proxy.base}/v1/3d/models`, {
      headers: { Authorization: `Bearer ${proxy.token}` },
      signal,
    })
    if (!response.ok) {
      return {
        models_3d: [],
        models_3d_note: friendlyMediaError('Listing 3D models', response.status, await response.text()),
      }
    }
    const data = (await response.json()) as { models?: unknown[] }
    return { models_3d: data.models ?? [] }
  } catch (err: any) {
    return { models_3d: [], models_3d_note: `Listing 3D models failed: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// generate_video
// ---------------------------------------------------------------------------

/** Poll cadence and the blocking budget for `wait: true`. Mutable for tests. */
export const VIDEO_POLL = { intervalMs: 5_000, timeoutMs: 10 * 60_000 }

type VideoJobState = 'queued' | 'in_progress' | 'completed' | 'failed'

interface VideoStatusResponse {
  id: string
  status: VideoJobState
  model?: string
  duration?: number
  audio?: boolean
  queue_position?: number
  error?: string
  video?: { url: string; content_type?: string; file_size?: number }
}

interface TrackedVideoJob {
  id: string
  prompt: string
  model: string
  duration: number
  audio: boolean
  target: OutputTarget
  status: VideoJobState
  path?: string
  bytes?: number
  error?: string
  /** Settles when the background follower finishes (saved, failed or gave up). */
  done?: Promise<void>
}

/** Jobs submitted from this runtime, so a later `generate_video({ job_id })` knows where to save. */
const trackedVideoJobs = new Map<string, TrackedVideoJob>()

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchVideoStatus(proxy: ProxyConfig, id: string, signal?: AbortSignal): Promise<VideoStatusResponse> {
  const response = await fetch(`${proxy.base}/v1/videos/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${proxy.token}` },
    signal,
  })
  if (!response.ok) {
    throw new Error(friendlyMediaError('Video status check', response.status, await response.text()))
  }
  return (await response.json()) as VideoStatusResponse
}

async function saveVideo(job: TrackedVideoJob, video: NonNullable<VideoStatusResponse['video']>, signal?: AbortSignal) {
  const response = await fetch(video.url, { signal })
  if (!response.ok) throw new Error(`Video download failed (${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const dest = job.target.pathFor(0, 1, video.content_type || response.headers.get('content-type') || 'video/mp4')
  writeFileSync(dest.absolute, buffer)
  job.status = 'completed'
  job.path = dest.workspacePath
  job.bytes = buffer.length
}

/**
 * Poll until the job settles, saving the file on completion. Returns false
 * when `deadline` passes first (the job is still running upstream).
 */
async function followVideoJob(proxy: ProxyConfig, job: TrackedVideoJob, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (true) {
    const status = await fetchVideoStatus(proxy, job.id, signal)
    if (status.status === 'completed' && status.video) {
      await saveVideo(job, status.video, signal)
      return true
    }
    if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || 'Video generation failed'
      return true
    }
    job.status = status.status
    if (Date.now() + VIDEO_POLL.intervalMs > deadline) return false
    await sleep(VIDEO_POLL.intervalMs, signal)
  }
}

/** Keep following a job after the tool call returns, so the file still lands (and the job is billed) when it finishes. */
function followInBackground(proxy: ProxyConfig, job: TrackedVideoJob): void {
  if (job.done) return
  const deadline = Date.now() + 60 * 60_000
  job.done = followVideoJob(proxy, job, deadline)
    .then((settled) => {
      if (!settled) {
        job.status = 'failed'
        job.error = 'Gave up waiting for the video after an hour.'
      }
    })
    .catch((err) => {
      job.status = 'failed'
      job.error = err?.message || String(err)
      console.error(`[generate_video] background job ${job.id} failed:`, job.error)
    })
}

function jobResult(job: TrackedVideoJob, extra: Record<string, unknown> = {}) {
  return textResult({
    id: job.id,
    status: job.status,
    path: job.path,
    paths: job.path ? [job.path] : undefined,
    model: job.model,
    duration: job.duration,
    audio: job.audio,
    prompt: job.prompt,
    bytes: job.bytes,
    error: job.error,
    ...extra,
  })
}

/**
 * `genjutsu` mode → model id, so a caller can ask for the workflow by name.
 * Everything else passes no model at all: the proxy's default follows whichever
 * provider is configured.
 */
export const GENJUTSU_MODEL_BY_MODE = {
  motion_transfer: 'hf-genjutsu-motion-transfer',
  object_swap: 'hf-genjutsu-object-swap',
  restyle: 'hf-genjutsu-restyle',
} as const

function createGenerateVideoTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_video',
    description:
      'Generate a video clip from a text prompt, or animate a still image by passing start_image (recommended: make the still with generate_image first). ' +
      'Also edits an existing clip: pass source_video with genjutsu "motion_transfer" | "object_swap" | "restyle" (restyle needs a preset_id from the presets list). ' +
      'Saves an MP4 to videos/ by default; pass path to save anywhere in the workspace. Billed per clip on Higgsfield (the estimate comes back on submit) — call list_media_models for prices. ' +
      'Waits for the clip (usually 1-5 minutes). Pass wait: false to queue several shots at once, then call generate_video({ job_id }) to check each one.',
    label: 'Generate Video',
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: 'What happens in the shot: subject, action, camera movement, style' })),
      model: Type.Optional(
        Type.String({
          description:
            'Video model id. Omit it to use the workspace default (hf-hailuo-2.3). "hf-kling-3.0-std" for 3–15 s clips with native sound, "hf-kling-3.0-pro" for multi-shot plus last-frame control, "hf-wan-2.6" for stylized looks up to 15 s, "hf-ltx-2.5-fast" for the cheapest text-to-video that takes an aspect_ratio, "hf-genjutsu-*" to edit a clip. Retired ids still resolve to the model that replaced them. See list_media_models.',
        }),
      ),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: 'Clip length in seconds; each model allows specific values (list_media_models shows the range — Kling 3.0 takes 3–15). A Genjutsu edit follows its source clip.' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'e.g. "16:9", "9:16", "1:1". Only models that list one accept it — Hailuo, Kling and Wan follow the start image, so pass a portrait start_image for a 9:16 ad.' })),
      resolution: Type.Optional(Type.String({ description: 'Resolution tier on models that have one: "480p" | "720p" | "1080p" ("720p" default). Cheaper tiers render faster.' })),
      audio: Type.Optional(Type.Boolean({ description: 'Generate sound/dialogue on models that support it (costs more). Default false.' })),
      start_image: Type.Optional(Type.String({ description: 'Workspace image to use as the first frame (image-to-video)' })),
      reference_images: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: MAX_REFERENCE_IMAGES,
          description: 'Character/object reference images. Genjutsu motion_transfer and object_swap need at least one (the subject to drive or swap in).',
        }),
      ),
      source_video: Type.Optional(
        Type.String({
          description: 'Workspace .mp4 to edit (Genjutsu). Uploaded automatically; 200 MB limit, and the clip must be at least 4 s (trimmed to 30 s).',
        }),
      ),
      genjutsu: Type.Optional(
        Type.Union(
          [Type.Literal('motion_transfer'), Type.Literal('object_swap'), Type.Literal('restyle')],
          { description: 'Editing workflow when source_video is set: drive a subject image with the clip\'s motion, swap an object, or restyle the clip. Selecting it picks the matching model.' },
        ),
      ),
      preset_id: Type.Optional(
        Type.String({ description: 'Restyle style id (required for genjutsu "restyle"); list them with list_media_models kind "presets".' }),
      ),
      options: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description:
            'Model-specific documented fields for the chosen model, e.g. { "cfg_scale": 0.5 }, { "multi_shots": true }, { "multi_prompt": [{ "prompt": "…", "duration": 5 }] }, { "last_image_url": "https://…" }, { "seed": 42 }. list_media_models shows each model\'s fields, allowed values and ranges; anything undeclared is rejected.',
        }),
      ),
      path: Type.Optional(Type.String({ description: 'Output path anywhere in the workspace (e.g. "public/media/intro.mp4")' })),
      filename: Type.Optional(Type.String({ description: 'Destination filename under videos/ (ignored when path is set)' })),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the clip to finish (default true). false returns a job_id immediately.' })),
      job_id: Type.Optional(Type.String({ description: 'Check (and save, once finished) a job started earlier with wait: false' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        prompt?: string
        model?: string
        duration?: number
        aspect_ratio?: string
        resolution?: string
        audio?: boolean
        start_image?: string
        reference_images?: string[]
        source_video?: string
        genjutsu?: 'motion_transfer' | 'object_swap' | 'restyle'
        preset_id?: string
        options?: Record<string, unknown>
        path?: string
        filename?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: 'Video generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkVideoJob(ctx, proxy, p.job_id, p, signal)
      if (!p.prompt && !p.source_video) {
        return textResult({ error: 'prompt is required (or pass source_video for a Genjutsu edit, or job_id to check an earlier job).' })
      }
      const model = p.model ?? (p.genjutsu ? GENJUTSU_MODEL_BY_MODE[p.genjutsu] : undefined)

      let target: OutputTarget
      let startImage: string | undefined
      let sourceVideoUrl: string | undefined
      let sourceDurationSeconds: number | undefined
      const references: string[] = []
      try {
        if ((p.reference_images?.length ?? 0) > MAX_REFERENCE_IMAGES) {
          return textResult({ error: `At most ${MAX_REFERENCE_IMAGES} reference images are supported per call.` })
        }
        if (p.start_image) {
          const image = loadWorkspaceImage(ctx, p.start_image)
          if ('error' in image) return textResult({ error: image.error.replace('Reference image', 'Start image') })
          startImage = toDataUri(image)
        }
        for (const ref of p.reference_images ?? []) {
          const image = loadWorkspaceImage(ctx, ref)
          if ('error' in image) return textResult({ error: image.error })
          references.push(toDataUri(image))
        }
        if (p.source_video) {
          const video = loadWorkspaceVideo(ctx, p.source_video)
          if ('error' in video) return textResult({ error: video.error })
          const uploaded = await uploadSourceVideo(proxy, video.buffer, signal)
          if ('error' in uploaded) return textResult({ error: uploaded.error })
          sourceVideoUrl = uploaded.url
          // The edit is billed per source second; the proxy refuses the job if
          // it isn't told the length, so measure it here rather than guess.
          sourceDurationSeconds = video.durationSeconds
        } else if (p.genjutsu) {
          return textResult({ error: `genjutsu "${p.genjutsu}" edits an existing clip: pass source_video (a workspace .mp4).` })
        }
        target = resolveOutputTarget(ctx, {
          path: p.path,
          filename: p.filename,
          defaultDir: 'videos',
          prefix: 'video',
          defaultExt: '.mp4',
        })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      let submitted: { id: string; model: string; duration: number; audio: boolean; estimated_usd?: number; provider?: string }
      try {
        const response = await fetch(`${proxy.base}/v1/videos/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({
            prompt: p.prompt,
            model,
            duration: p.duration,
            aspect_ratio: p.aspect_ratio,
            resolution: p.resolution,
            audio: p.audio,
            start_image: startImage,
            reference_images: references.length > 0 ? references : undefined,
            source_video_url: sourceVideoUrl,
            source_duration_seconds: sourceDurationSeconds,
            preset_id: p.preset_id,
            options: p.options,
          }),
          signal,
        })
        if (!response.ok) {
          return textResult({ error: friendlyMediaError('Video generation', response.status, await response.text()) })
        }
        submitted = (await response.json()) as typeof submitted
      } catch (err: any) {
        return textResult({ error: `Video generation error: ${err.message}` })
      }

      const job: TrackedVideoJob = {
        id: submitted.id,
        prompt: p.prompt ?? '',
        model: submitted.model,
        duration: submitted.duration,
        audio: submitted.audio,
        target,
        status: 'queued',
      }
      trackedVideoJobs.set(job.id, job)
      const planned = target.pathFor(0, 1, 'video/mp4').workspacePath

      if (p.wait === false) {
        followInBackground(proxy, job)
        return jobResult(job, {
          job_id: job.id,
          planned_path: planned,
          estimated_usd: submitted.estimated_usd,
          start_image: p.start_image,
          message: `Queued. The video will be saved to ${planned} when it finishes; call generate_video({ job_id: "${job.id}" }) to check.`,
        })
      }

      try {
        const settled = await followVideoJob(proxy, job, Date.now() + VIDEO_POLL.timeoutMs, signal)
        if (!settled) {
          followInBackground(proxy, job)
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            message: `Still rendering after ${Math.round(VIDEO_POLL.timeoutMs / 60_000)} minutes. It will be saved to ${planned} when it finishes; call generate_video({ job_id: "${job.id}" }) to check.`,
          })
        }
        return jobResult(job, { estimated_usd: submitted.estimated_usd, start_image: p.start_image })
      } catch (err: any) {
        // The job keeps running upstream; keep following it so the file still lands.
        followInBackground(proxy, job)
        if (signal?.aborted) {
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            message: `Stopped waiting. The video is still rendering and will be saved to ${planned}.`,
          })
        }
        return jobResult(job, { error: `Video generation error: ${err.message}`, job_id: job.id })
      }
    },
  }
}

async function checkVideoJob(
  ctx: ToolContext,
  proxy: ProxyConfig,
  id: string,
  p: { path?: string; filename?: string; wait?: boolean },
  signal?: AbortSignal,
) {
  let job = trackedVideoJobs.get(id)
  try {
    if (!job) {
      // Submitted by another runtime process (e.g. before a restart): save wherever the caller says.
      job = {
        id,
        prompt: '',
        model: '',
        duration: 0,
        audio: false,
        target: resolveOutputTarget(ctx, { path: p.path, filename: p.filename, defaultDir: 'videos', prefix: 'video', defaultExt: '.mp4' }),
        status: 'queued',
      }
      trackedVideoJobs.set(id, job)
    }
    if (job.status === 'completed' || job.status === 'failed') return jobResult(job)

    if (p.wait === true) {
      const settled = await followVideoJob(proxy, job, Date.now() + VIDEO_POLL.timeoutMs, signal)
      if (!settled) followInBackground(proxy, job)
      return jobResult(job)
    }
    const status = await fetchVideoStatus(proxy, id, signal)
    if (!job.model && status.model) {
      job.model = status.model
      job.duration = status.duration ?? 0
      job.audio = status.audio ?? false
    }
    if (status.status === 'completed' && status.video) {
      await saveVideo(job, status.video, signal)
    } else if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || 'Video generation failed'
    } else {
      job.status = status.status
      followInBackground(proxy, job)
    }
    return jobResult(job, status.queue_position !== undefined ? { queue_position: status.queue_position } : {})
  } catch (err: any) {
    return textResult({ id, error: `Video status check failed: ${err.message}` })
  }
}

/** Media tools registered alongside `generate_image` (gating lives in `filterDisabledCapabilityTools`). */
export function createMediaTools(ctx: ToolContext): AgentTool[] {
  return [
    createListMediaModelsTool(ctx),
    createGenerateVideoTool(ctx),
    ...createThreeDTools(ctx),
  ]
}

/** Test seam. */
export const _testing = { trackedVideoJobs }
