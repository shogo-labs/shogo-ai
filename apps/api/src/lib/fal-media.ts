// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * fal.ai client for the AI proxy's media routes.
 *
 * Images and image utilities use fal's synchronous endpoint (`fal.run`);
 * video uses the queue (`queue.fal.run`) because a job runs for minutes.
 * Request bodies differ per model family, so the shaping lives here rather
 * than in the shared model catalog. Reference images are passed as data URIs,
 * which fal accepts anywhere it takes a file URL.
 */

import type { ImageModelEntry, VideoModelEntry } from '@shogo/model-catalog'

export const FAL_RUN_BASE = 'https://fal.run'
export const FAL_QUEUE_BASE = 'https://queue.fal.run'

export interface FalImageResult {
  created: number
  data: Array<{ b64_json: string; revised_prompt?: string; content_type?: string }>
}

export interface FalImageParams {
  prompt: string
  size?: string
  quality?: string
  n?: number
  /** Data URIs (or https URLs) of reference images. */
  referenceImages?: string[]
}

const SIZE_TO_ASPECT: Record<string, string> = {
  '1024x1024': '1:1',
  '1024x1792': '9:16',
  '1792x1024': '16:9',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
}

function parseSize(size: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size || '')
  if (!match) return { width: 1024, height: 1024 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

export function sizeToAspectRatio(size: string | undefined): string {
  if (size && SIZE_TO_ASPECT[size]) return SIZE_TO_ASPECT[size]
  const { width, height } = parseSize(size)
  const d = gcd(width, height)
  return `${width / d}:${height / d}`
}

function isHighQuality(quality: string | undefined): boolean {
  return quality === 'hd' || quality === 'high'
}

export interface FalRequest {
  endpoint: string
  input: Record<string, unknown>
}

/**
 * Build the fal request(s) for one image generation. Models without a
 * `num_images` parameter (Recraft) get one request per image.
 */
export function buildFalImageRequests(entry: ImageModelEntry, params: FalImageParams): FalRequest[] {
  const n = Math.max(1, Math.min(4, params.n || 1))
  const refs = params.referenceImages ?? []
  const hasRefs = refs.length > 0
  const endpoint = hasRefs && entry.editApiModel ? entry.editApiModel : entry.apiModel
  const base: Record<string, unknown> = { prompt: params.prompt }

  if (entry.id.startsWith('nano-banana')) {
    return [{
      endpoint,
      input: {
        ...base,
        num_images: n,
        aspect_ratio: sizeToAspectRatio(params.size),
        resolution: isHighQuality(params.quality) ? '2K' : '1K',
        output_format: 'png',
        ...(hasRefs ? { image_urls: refs } : {}),
      },
    }]
  }
  if (entry.id.startsWith('seedream')) {
    return [{
      endpoint,
      input: {
        ...base,
        num_images: n,
        image_size: parseSize(params.size),
        ...(hasRefs ? { image_urls: refs } : {}),
      },
    }]
  }
  if (entry.id.startsWith('flux-pro-ultra')) {
    return [{
      endpoint,
      input: {
        ...base,
        num_images: n,
        aspect_ratio: sizeToAspectRatio(params.size),
        output_format: 'png',
        ...(hasRefs ? { image_url: refs[0] } : {}),
      },
    }]
  }
  if (entry.id.startsWith('ideogram')) {
    return [{
      endpoint,
      input: {
        ...base,
        num_images: n,
        image_size: parseSize(params.size),
        rendering_speed: isHighQuality(params.quality) ? 'QUALITY' : 'BALANCED',
        ...(hasRefs ? { image_urls: refs } : {}),
      },
    }]
  }
  if (entry.id.startsWith('recraft')) {
    return Array.from({ length: n }, () => ({
      endpoint,
      input: { ...base, image_size: parseSize(params.size) },
    }))
  }
  return [{
    endpoint,
    input: {
      ...base,
      num_images: n,
      image_size: parseSize(params.size),
      ...(hasRefs ? { image_urls: refs } : {}),
    },
  }]
}

function falHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` }
}

async function falErrorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { detail?: unknown; error?: unknown }
    const detail = json.detail ?? json.error
    if (typeof detail === 'string') return detail
    if (detail) return JSON.stringify(detail)
  } catch {}
  return text
}

/** Run a model on fal's synchronous endpoint and return its JSON output. */
export async function falRun(
  apiKey: string,
  endpoint: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch(`${FAL_RUN_BASE}/${endpoint}`, {
    method: 'POST',
    headers: falHeaders(apiKey),
    body: JSON.stringify(input),
    signal,
  })
  if (!response.ok) {
    throw new Error(`fal error (${response.status}): ${await falErrorText(response)}`)
  }
  return response.json()
}

/** Download a fal output (URL or data URI) as base64. */
export async function fetchAsBase64(
  url: string,
  signal?: AbortSignal,
): Promise<{ b64: string; contentType: string }> {
  const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (dataUri) {
    const contentType = dataUri[1] || 'application/octet-stream'
    const b64 = dataUri[2] ? dataUri[3] : Buffer.from(decodeURIComponent(dataUri[3])).toString('base64')
    return { b64, contentType }
  }
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`fal output download failed (${response.status})`)
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  return { b64: Buffer.from(await response.arrayBuffer()).toString('base64'), contentType }
}

/** Generate (or edit, when reference images are given) images on fal. */
export async function generateImageFal(
  apiKey: string,
  entry: ImageModelEntry,
  params: FalImageParams,
  signal?: AbortSignal,
): Promise<FalImageResult> {
  const requests = buildFalImageRequests(entry, params)
  const outputs = await Promise.all(requests.map((req) => falRun(apiKey, req.endpoint, req.input, signal)))
  const images = outputs.flatMap((out: any) => (Array.isArray(out?.images) ? out.images : out?.image ? [out.image] : []))
  if (images.length === 0) throw new Error('fal returned no images')
  const data = await Promise.all(
    images.map(async (img: { url: string; content_type?: string }) => {
      const { b64, contentType } = await fetchAsBase64(img.url, signal)
      return { b64_json: b64, revised_prompt: params.prompt, content_type: img.content_type || contentType }
    }),
  )
  return { created: Math.floor(Date.now() / 1000), data }
}

// =============================================================================
// Image utilities
// =============================================================================

export type ImageProcessOperation = 'upscale' | 'remove-background'

export const FAL_IMAGE_PROCESS_MODELS: Record<ImageProcessOperation, string> = {
  upscale: 'fal-ai/clarity-upscaler',
  'remove-background': 'fal-ai/birefnet/v2',
}

export interface ImageProcessResult {
  b64_json: string
  content_type: string
  width?: number
  height?: number
}

export async function processImageFal(
  apiKey: string,
  operation: ImageProcessOperation,
  imageUrl: string,
  options: { scale?: number } = {},
  signal?: AbortSignal,
): Promise<ImageProcessResult> {
  const input: Record<string, unknown> = { image_url: imageUrl }
  if (operation === 'upscale') input.upscale_factor = Math.max(1, Math.min(4, options.scale || 2))
  if (operation === 'remove-background') input.output_format = 'png'
  const out = await falRun(apiKey, FAL_IMAGE_PROCESS_MODELS[operation], input, signal)
  const image = out?.image as { url?: string; content_type?: string; width?: number; height?: number } | undefined
  if (!image?.url) throw new Error('fal returned no image')
  const { b64, contentType } = await fetchAsBase64(image.url, signal)
  return {
    b64_json: b64,
    content_type: image.content_type || contentType,
    width: image.width,
    height: image.height,
  }
}

// =============================================================================
// Video (queue API)
// =============================================================================

export interface FalVideoParams {
  prompt: string
  duration: number
  aspectRatio?: string
  audio?: boolean
  /** Data URI of the first frame, for image-to-video. */
  startImage?: string
  /** Data URIs of character/object references (Kling 3 only). */
  referenceImages?: string[]
}

/** Build the fal queue request for one video generation. */
export function buildFalVideoRequest(entry: VideoModelEntry, params: FalVideoParams): FalRequest {
  const imageToVideo = !!params.startImage
  if (imageToVideo && !entry.imageToVideoApiModel) {
    throw new Error(`${entry.displayName} does not support image-to-video`)
  }
  const endpoint = imageToVideo ? entry.imageToVideoApiModel! : entry.textToVideoApiModel
  const audio = entry.usdPerSecondWithAudio !== undefined ? params.audio ?? false : undefined
  const input: Record<string, unknown> = { prompt: params.prompt }

  if (entry.id.startsWith('kling-3')) {
    input.duration = String(params.duration)
    input.generate_audio = audio
    if (imageToVideo) input.start_image_url = params.startImage
    else if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
    const refs = params.referenceImages ?? []
    if (refs.length > 0) {
      input.elements = [{ frontal_image_url: refs[0], reference_image_urls: refs.slice(1) }]
    }
  } else if (entry.id.startsWith('kling')) {
    input.duration = String(params.duration)
    if (imageToVideo) input.image_url = params.startImage
    else if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
  } else if (entry.id.startsWith('veo')) {
    input.duration = `${params.duration}s`
    input.generate_audio = audio
    input.resolution = '720p'
    if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
    if (imageToVideo) input.image_url = params.startImage
  } else if (entry.id.startsWith('minimax')) {
    input.duration = params.duration
    input.resolution = '768P'
    input.prompt_expansion_mode = 'balanced'
    if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
    if (imageToVideo) input.image_url = params.startImage
  } else {
    input.duration = params.duration
    if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
    if (imageToVideo) input.image_url = params.startImage
  }
  return { endpoint, input }
}

export interface FalQueueSubmission {
  requestId: string
  statusUrl: string
  responseUrl: string
}

export async function falQueueSubmit(
  apiKey: string,
  request: FalRequest,
  signal?: AbortSignal,
): Promise<FalQueueSubmission> {
  const response = await fetch(`${FAL_QUEUE_BASE}/${request.endpoint}`, {
    method: 'POST',
    headers: falHeaders(apiKey),
    body: JSON.stringify(request.input),
    signal,
  })
  if (!response.ok) {
    throw new Error(`fal error (${response.status}): ${await falErrorText(response)}`)
  }
  const body = await response.json() as { request_id?: string; status_url?: string; response_url?: string }
  if (!body.request_id || !body.status_url || !body.response_url) {
    throw new Error('fal queue submit returned no request id')
  }
  return { requestId: body.request_id, statusUrl: body.status_url, responseUrl: body.response_url }
}

export type FalQueueState = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

export interface FalQueueStatus {
  status: FalQueueState
  queuePosition?: number
  error?: string
}

function assertQueueUrl(url: string): void {
  if (!url.startsWith(`${FAL_QUEUE_BASE}/`)) throw new Error('Refusing non-fal queue URL')
}

export async function falQueueStatus(apiKey: string, statusUrl: string, signal?: AbortSignal): Promise<FalQueueStatus> {
  assertQueueUrl(statusUrl)
  const response = await fetch(statusUrl, { headers: falHeaders(apiKey), signal })
  // A finished job's status endpoint answers 200; a failed one may answer 4xx/5xx with a detail.
  const body = await response.json().catch(() => ({})) as {
    status?: FalQueueState
    queue_position?: number
    error?: string
    detail?: unknown
  }
  if (!response.ok && !body.status) {
    throw new Error(`fal status error (${response.status}): ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? '')}`)
  }
  return {
    status: body.status ?? 'IN_QUEUE',
    queuePosition: body.queue_position,
    error: body.error,
  }
}

export interface FalVideoOutput {
  url: string
  contentType: string
  fileSize?: number
}

export async function falQueueVideoResult(apiKey: string, responseUrl: string, signal?: AbortSignal): Promise<FalVideoOutput> {
  assertQueueUrl(responseUrl)
  const response = await fetch(responseUrl, { headers: falHeaders(apiKey), signal })
  if (!response.ok) {
    throw new Error(`fal error (${response.status}): ${await falErrorText(response)}`)
  }
  const body = await response.json() as { video?: { url?: string; content_type?: string; file_size?: number } }
  if (!body.video?.url) throw new Error('fal returned no video')
  return {
    url: body.video.url,
    contentType: body.video.content_type || 'video/mp4',
    fileSize: body.video.file_size,
  }
}
