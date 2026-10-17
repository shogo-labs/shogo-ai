// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Media tools: image generation and editing, image utilities (upscale,
 * background removal), video generation, and the model/price listing the
 * agent uses to choose between them. Every call goes through the AI proxy
 * (`/ai/v1/images/*`, `/ai/v1/videos/*`, `/ai/v1/media/models`), which owns
 * provider keys and billing.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve, extname, dirname, relative, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { assertWithinWorkspace } from './permission-engine'

export { IMAGE_TOOL_NAMES, VIDEO_TOOL_NAMES, MEDIA_TOOL_NAMES } from './media-tool-names'

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
  'Image model id (default "gpt-image-2.5-flare"). Call list_media_models for the full list with prices. ' +
  'Rough guide: "nano-banana-pro" for keeping a character consistent across shots and multi-reference edits ' +
  '("nano-banana-2" is cheaper), "seedream-5-pro" for stylized art, "flux-pro-ultra" for photorealism, ' +
  '"ideogram-3" for text in images (posters, logos), "recraft-3" for vector and brand work, ' +
  '"gpt-image-2.5-flare"/"gpt-image-2" for general prompt following, "imagen-4" for fast text-to-image.'

export function createGenerateImageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_image',
    description:
      'Generate one to four image options from a text prompt. Pass reference_images (workspace paths) to edit an image or to keep a character, product or style consistent across shots. ' +
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
        Type.Integer({
          minimum: 1,
          maximum: 4,
          description: 'Number of image options to generate (1-4, default: 1)',
        }),
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
        options?: number
      }
      const { prompt, size = '1024x1024', model = 'gpt-image-2.5-flare', quality = 'standard', options = 1 } = p

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
          formData.append('model', model)
          formData.append('size', size)
          formData.append('quality', quality)
          formData.append('n', String(options))
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
            body: JSON.stringify({ prompt, model, size, quality, n: options }),
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
          model,
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
      'List the image and video models you can use, with what each is best for, whether it accepts reference images or a start frame, its main parameters, and its Shogo price (per image or per second of video). ' +
      'Check this before choosing a model or planning a batch so you can budget it.',
    label: 'List Media Models',
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('all')], {
          description: 'Which models to list (default: "all")',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { kind = 'all' } = params as { kind?: 'image' | 'video' | 'all' }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: 'Media models are not available: AI proxy not configured.' })
      try {
        const response = await fetch(`${proxy.base}/v1/media/models`, {
          headers: { Authorization: `Bearer ${proxy.token}` },
          signal,
        })
        if (!response.ok) {
          return textResult({ error: friendlyMediaError('Listing media models', response.status, await response.text()) })
        }
        const data = (await response.json()) as { images?: unknown[]; videos?: unknown[]; utilities?: unknown[]; currency?: string; note?: string }
        const imageOn = ctx.config?.imageGenEnabled !== false
        const videoOn = ctx.config?.videoGenEnabled === true
        return textResult({
          ...(kind !== 'video' && imageOn ? { images: data.images ?? [], utilities: data.utilities ?? [] } : {}),
          ...(kind !== 'image'
            ? videoOn
              ? { videos: data.videos ?? [] }
              : { videos: [], videos_note: 'Video generation is off for this project. The user can enable it in Capabilities.' }
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

// ---------------------------------------------------------------------------
// upscale_image / remove_background
// ---------------------------------------------------------------------------

type ProcessOperation = 'upscale' | 'remove-background'

async function runImageProcess(
  ctx: ToolContext,
  operation: ProcessOperation,
  p: { path: string; output_path?: string; scale?: number },
  suffix: string,
  signal?: AbortSignal,
) {
  const proxy = proxyConfig(ctx)
  if (!proxy) return textResult({ error: 'Image tools are not available: AI proxy not configured.' })

  let input: LoadedImage
  let target: OutputTarget
  try {
    const loaded = loadWorkspaceImage(ctx, p.path)
    if ('error' in loaded) return textResult({ error: loaded.error.replace('Reference image', 'Image') })
    input = loaded
    const inputAbs = assertWithinWorkspace(ctx.workspaceDir, p.path)
    const ext = extname(inputAbs)
    const defaultOut = toWorkspaceRelative(ctx.workspaceDir, `${ext ? inputAbs.slice(0, -ext.length) : inputAbs}-${suffix}`)
    target = resolveOutputTarget(ctx, {
      path: p.output_path || defaultOut,
      defaultDir: 'images',
      prefix: suffix,
      defaultExt: '.png',
    })
  } catch (err: any) {
    return textResult({ error: err.message })
  }

  const context = operation === 'upscale' ? 'Image upscale' : 'Background removal'
  try {
    const response = await fetch(`${proxy.base}/v1/images/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ operation, image: toDataUri(input), scale: p.scale }),
      signal,
    })
    if (!response.ok) {
      return textResult({ error: friendlyMediaError(context, response.status, await response.text()) })
    }
    const data = (await response.json()) as { data?: Array<{ b64_json?: string; content_type?: string; width?: number; height?: number }> }
    const out = data.data?.[0]
    if (!out?.b64_json) return textResult({ error: 'No image data received from provider' })
    const buffer = Buffer.from(out.b64_json, 'base64')
    const dest = target.pathFor(0, 1, out.content_type)
    writeFileSync(dest.absolute, buffer)
    return textResult({
      path: dest.workspacePath,
      paths: [dest.workspacePath],
      source: p.path,
      operation,
      width: out.width,
      height: out.height,
      bytes: buffer.length,
    })
  } catch (err: any) {
    return textResult({ error: `${context} error: ${err.message}` })
  }
}

function createUpscaleImageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'upscale_image',
    description:
      'Upscale a workspace image (2x by default, up to 4x) while adding detail. Saves next to the original as <name>-upscaled unless output_path is set. Billed per output megapixel.',
    label: 'Upscale Image',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace path of the image to upscale' }),
      scale: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: 'Upscale factor 1-4 (default: 2)' })),
      output_path: Type.Optional(Type.String({ description: 'Where to save the result (any workspace path)' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runImageProcess(ctx, 'upscale', params as { path: string; scale?: number; output_path?: string }, 'upscaled', signal),
  }
}

function createRemoveBackgroundTool(ctx: ToolContext): AgentTool {
  return {
    name: 'remove_background',
    description:
      'Remove the background from a workspace image, producing a transparent PNG (for sprites, product shots, stickers, logos). Saves next to the original as <name>-nobg.png unless output_path is set.',
    label: 'Remove Background',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace path of the image' }),
      output_path: Type.Optional(Type.String({ description: 'Where to save the transparent PNG (any workspace path)' })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runImageProcess(ctx, 'remove-background', params as { path: string; output_path?: string }, 'nobg', signal),
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

function createGenerateVideoTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_video',
    description:
      'Generate a video clip from a text prompt, or animate a still image by passing start_image (recommended: make the still with generate_image first). ' +
      'Saves an MP4 to videos/ by default; pass path to save anywhere in the workspace. Billed per second of video, so use the shortest duration that works and call list_media_models for prices. ' +
      'Waits for the clip (usually 1-5 minutes). Pass wait: false to queue several shots at once, then call generate_video({ job_id }) to check each one.',
    label: 'Generate Video',
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: 'What happens in the shot: subject, action, camera movement, style' })),
      model: Type.Optional(
        Type.String({
          description:
            'Video model id (default "kling-2.5-turbo-pro"). "kling-3-pro" for fluid motion and character references, "veo-3.1-fast" for cinematic shots with sound, "minimax-h3-max" for stylized looks. See list_media_models.',
        }),
      ),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Clip length in seconds; each model allows specific values (see list_media_models)' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'e.g. "16:9", "9:16", "1:1" (text-to-video; image-to-video follows the start image)' })),
      audio: Type.Optional(Type.Boolean({ description: 'Generate sound/dialogue on models that support it (costs more). Default false.' })),
      start_image: Type.Optional(Type.String({ description: 'Workspace image to use as the first frame (image-to-video)' })),
      reference_images: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: MAX_REFERENCE_IMAGES,
          description: 'Character/object reference images for models that accept them (kling-3-pro)',
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
        audio?: boolean
        start_image?: string
        reference_images?: string[]
        path?: string
        filename?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: 'Video generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkVideoJob(ctx, proxy, p.job_id, p, signal)
      if (!p.prompt) return textResult({ error: 'prompt is required (or pass job_id to check an earlier job).' })

      let target: OutputTarget
      let startImage: string | undefined
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

      let submitted: { id: string; model: string; duration: number; audio: boolean; estimated_usd?: number }
      try {
        const response = await fetch(`${proxy.base}/v1/videos/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({
            prompt: p.prompt,
            model: p.model,
            duration: p.duration,
            aspect_ratio: p.aspect_ratio,
            audio: p.audio,
            start_image: startImage,
            reference_images: references.length > 0 ? references : undefined,
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
        prompt: p.prompt,
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
    createUpscaleImageTool(ctx),
    createRemoveBackgroundTool(ctx),
    createGenerateVideoTool(ctx),
  ]
}

/** Test seam. */
export const _testing = { trackedVideoJobs }
