// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Higgsfield client for the AI proxy's media routes.
 *
 * Everything on Higgsfield is asynchronous: `POST /<endpoint-id>` returns a
 * request handle (`request_id`, `status_url`, `cancel_url`), and the caller
 * polls `GET /requests/{id}/status` until the status is terminal. Images are
 * async too, so the OpenAI-shaped image route submits, polls, then downloads
 * the output inside the request.
 *
 * Three facts shape this module:
 *
 *   1. **Only `completed` is billable.** `failed`, `nsfw` and `canceled`
 *      requests are refunded upstream, so the proxy must never charge them.
 *   2. **Input media must be public URLs.** Local files are uploaded through
 *      `POST /files/generate-upload-url` and the returned `upload_headers` are
 *      sent verbatim on the `PUT` (they carry the retention tag); the API
 *      credentials never go to the storage host.
 *   3. **`/estimate` is free and is the price.** The submit captures the
 *      estimate and the completion bills exactly that, marked up.
 *
 * The endpoint ids below are checked against the committed snapshot in
 * `docs/vendors/higgsfield/catalog.json` by `bun run check:higgsfield-docs`;
 * changing one here without refreshing the snapshot fails CI.
 */

import type { ImageModelEntry, VideoModelEntry } from '@shogo/model-catalog'

export const HIGGSFIELD_DEFAULT_BASE = 'https://api.higgsfield.ai'

/** Restyle presets endpoint (documented under the Restyle model page). */
export const HIGGSFIELD_RESTYLE_PRESETS_PATH = '/models/higgsfield/genjutsu/restyle/v1.0/presets'

/**
 * Base URL, overridable so the mock server (and the live e2e tiers) can point
 * the whole client somewhere else. Trailing slashes are stripped so the SSRF
 * guard's prefix check is exact.
 */
export function higgsfieldBase(): string {
  return (process.env.HIGGSFIELD_BASE_URL || HIGGSFIELD_DEFAULT_BASE).replace(/\/+$/, '')
}

/** Terminal request states. Everything else (queued, in_progress) keeps polling. */
export const HIGGSFIELD_TERMINAL_STATUSES = ['completed', 'failed', 'nsfw', 'canceled'] as const
export type HiggsfieldTerminalStatus = (typeof HIGGSFIELD_TERMINAL_STATUSES)[number]
export type HiggsfieldStatus = 'queued' | 'in_progress' | HiggsfieldTerminalStatus

export type HiggsfieldErrorCode =
  | 'provider_busy'
  | 'auth'
  | 'credits'
  | 'not_found'
  | 'validation'
  | 'blocked'
  | 'unavailable'
  | 'server'
  | 'http'
  | 'timeout'
  | 'unsafe_url'

/** A Higgsfield or transport failure, carrying enough detail to answer the caller well. */
export class HiggsfieldError extends Error {
  readonly status?: number
  readonly code: HiggsfieldErrorCode
  readonly requestId?: string

  constructor(message: string, code: HiggsfieldErrorCode, status?: number, requestId?: string) {
    super(message)
    this.name = 'HiggsfieldError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

function headers(apiKey: string, withContentType = false): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    ...(withContentType ? { 'Content-Type': 'application/json' } : {}),
  }
}

/** Only poll URLs the configured base owns — never follow a foreign host. */
export function assertHiggsfieldUrl(url: string, base = higgsfieldBase()): void {
  if (!url.startsWith(`${base}/`)) {
    throw new HiggsfieldError('Refusing to poll a non-Higgsfield URL', 'unsafe_url')
  }
}

/**
 * FastAPI error envelope: `detail` is a string, or a list of validation
 * entries when the request failed schema validation.
 */
export function formatHiggsfieldError(status: number, body: unknown): { message: string; code: HiggsfieldErrorCode } {
  const detail = (body as { detail?: unknown } | null)?.detail
  let text = ''
  if (typeof detail === 'string') {
    text = detail
  } else if (Array.isArray(detail)) {
    text = detail
      .map((entry) => {
        if (typeof entry === 'string') return entry
        const e = entry as { msg?: string; loc?: unknown[] }
        const where = Array.isArray(e.loc) ? e.loc.join('.') : ''
        return [where, e.msg].filter(Boolean).join(': ')
      })
      .filter(Boolean)
      .join('; ')
  } else if (detail) {
    text = JSON.stringify(detail)
  }
  if (!text) text = `HTTP ${status}`

  let code: HiggsfieldErrorCode
  if (status === 401) code = 'auth'
  else if (status === 403) code = 'credits'
  else if (status === 404) code = 'not_found'
  else if (status === 422) code = 'validation'
  else if (status === 423) code = 'blocked'
  else if (status === 503) code = 'unavailable'
  else if (status >= 500) code = 'server'
  // A 400 is either a bad parameter or the account concurrency limit. The run
  // can't be retried in a loop, so name it and let the caller say "retry soon".
  else if (status === 400 && /concurren/i.test(text)) code = 'provider_busy'
  else if (status === 400) code = 'validation'
  else code = 'http'

  const prefix =
    code === 'provider_busy'
      ? 'Higgsfield is at its concurrency limit — retry in a moment. '
      : `Higgsfield error (${status}): `
  return { message: `${prefix}${text}`.trim(), code }
}

async function throwForResponse(response: Response, requestId?: string): Promise<never> {
  const text = await response.text().catch(() => '')
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { detail: text }
  }
  const { message, code } = formatHiggsfieldError(response.status, body)
  throw new HiggsfieldError(message, code, response.status, requestId)
}

// -----------------------------------------------------------------------------
// Estimation
// -----------------------------------------------------------------------------

export interface HiggsfieldEstimate {
  /** USD for one request, as quoted by the vendor. */
  rawUsd: number
  /** Credits the request will consume, when the vendor reports them. */
  credits?: number
}

/**
 * `/estimate` returns numbers as strings (`"credits": "1.500"`). Parse them,
 * and treat an unparseable or missing `usd` as "no estimate" rather than 0 —
 * billing must never silently fall back to free.
 */
export function parseHiggsfieldEstimate(body: unknown): HiggsfieldEstimate | null {
  const b = body as { usd?: unknown; credits?: unknown } | null
  const rawUsd = typeof b?.usd === 'number' ? b.usd : Number.parseFloat(String(b?.usd ?? ''))
  if (!Number.isFinite(rawUsd) || rawUsd < 0) return null
  const credits = typeof b?.credits === 'number' ? b.credits : Number.parseFloat(String(b?.credits ?? ''))
  return { rawUsd, ...(Number.isFinite(credits) ? { credits } : {}) }
}

export async function higgsfieldEstimate(
  apiKey: string,
  endpoint: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HiggsfieldEstimate> {
  const response = await fetch(`${higgsfieldBase()}/estimate/${endpoint}`, {
    method: 'POST',
    headers: headers(apiKey, true),
    body: JSON.stringify(input),
    signal,
  })
  if (!response.ok) await throwForResponse(response)
  const body = await response.json().catch(() => null)
  const estimate = parseHiggsfieldEstimate(body)
  if (!estimate) {
    // Token-priced endpoints (Marketing Studio 2.5 Flare/Sunburst, Ads Studio)
    // answer with a rate-card description — `image output $30/1M` — instead of
    // an amount. There is no per-request figure to bill, so say that rather
    // than a generic "no estimate" the caller can only retry forever.
    if ((body as { type?: string } | null)?.type === 'description') {
      throw new HiggsfieldError('Higgsfield prices this model per token and returned no per-request amount', 'unavailable')
    }
    throw new HiggsfieldError('Higgsfield returned no usable price estimate', 'validation')
  }
  return estimate
}

// -----------------------------------------------------------------------------
// Submission / status / cancel
// -----------------------------------------------------------------------------

export interface HiggsfieldSubmission {
  requestId: string
  status: HiggsfieldStatus
  statusUrl: string
  cancelUrl?: string
}

export async function higgsfieldSubmit(
  apiKey: string,
  endpoint: string,
  input: Record<string, unknown>,
  opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<HiggsfieldSubmission> {
  const response = await fetch(`${higgsfieldBase()}/${endpoint}`, {
    method: 'POST',
    headers: {
      ...headers(apiKey, true),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify(input),
    signal: opts.signal,
  })
  if (!response.ok) await throwForResponse(response)
  const body = (await response.json().catch(() => null)) as {
    request_id?: string
    status?: HiggsfieldStatus
    status_url?: string
    cancel_url?: string
  } | null
  if (!body?.request_id || !body.status_url) {
    throw new HiggsfieldError('Higgsfield accepted the request but returned no request id', 'http')
  }
  assertHiggsfieldUrl(body.status_url)
  return {
    requestId: body.request_id,
    status: body.status ?? 'queued',
    statusUrl: body.status_url,
    cancelUrl: body.cancel_url,
  }
}

export interface HiggsfieldRequestResult {
  status: HiggsfieldStatus
  requestId?: string
  /** Image outputs, in the vendor's order. */
  imageUrls: string[]
  /** Video output, for the video and Genjutsu endpoints. */
  videoUrl?: string
  error?: string
}

export function parseHiggsfieldStatus(body: unknown): HiggsfieldRequestResult {
  const b = (body ?? {}) as {
    status?: string
    request_id?: string
    error?: unknown
    images?: Array<{ url?: string } | string>
    video?: { url?: string }
  }
  const status = (b.status ?? 'queued') as HiggsfieldStatus
  const imageUrls = (Array.isArray(b.images) ? b.images : [])
    .map((img) => (typeof img === 'string' ? img : img?.url))
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
  const error =
    typeof b.error === 'string' ? b.error : b.error ? JSON.stringify(b.error) : status === 'nsfw' ? 'The request was blocked by the provider content filter.' : undefined
  return {
    status,
    requestId: b.request_id,
    imageUrls,
    videoUrl: typeof b.video?.url === 'string' ? b.video.url : undefined,
    error,
  }
}

export async function higgsfieldStatus(
  apiKey: string,
  statusUrl: string,
  signal?: AbortSignal,
): Promise<HiggsfieldRequestResult> {
  assertHiggsfieldUrl(statusUrl)
  const response = await fetch(statusUrl, { headers: headers(apiKey), signal })
  if (!response.ok) await throwForResponse(response)
  return parseHiggsfieldStatus(await response.json().catch(() => null))
}

export async function higgsfieldCancel(apiKey: string, requestId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${higgsfieldBase()}/requests/${requestId}/cancel`, {
    method: 'POST',
    headers: headers(apiKey),
    signal,
  })
  // 202 with an empty body on success; a request that already started cannot be canceled.
  if (!response.ok) await throwForResponse(response, requestId)
}

/** Poll once, then back off from 2 s to 10 s, until the request is terminal. */
export const HIGGSFIELD_POLL = { initialMs: 2_000, maxMs: 10_000, factor: 1.5 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll a submitted request until it reaches a terminal state. Throws a
 * `timeout` `HiggsfieldError` (carrying the request id) when `deadlineMs`
 * passes first — the request keeps running upstream, so nothing is billed.
 */
export async function pollHiggsfieldRequest(
  apiKey: string,
  statusUrl: string,
  opts: { deadlineMs: number; signal?: AbortSignal } = { deadlineMs: 5 * 60_000 },
): Promise<HiggsfieldRequestResult> {
  let delay = HIGGSFIELD_POLL.initialMs
  while (true) {
    const result = await higgsfieldStatus(apiKey, statusUrl, opts.signal)
    if ((HIGGSFIELD_TERMINAL_STATUSES as readonly string[]).includes(result.status)) return result
    if (Date.now() + delay > opts.deadlineMs) {
      throw new HiggsfieldError(
        'Higgsfield is still working on the request. Try again shortly.',
        'timeout',
        undefined,
        result.requestId,
      )
    }
    await sleep(delay)
    delay = Math.min(HIGGSFIELD_POLL.maxMs, Math.round(delay * HIGGSFIELD_POLL.factor))
  }
}

// -----------------------------------------------------------------------------
// Uploads
// -----------------------------------------------------------------------------

/** Audio/video/image types the upload endpoint accepts. */
export const HIGGSFIELD_UPLOAD_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/wav',
  'audio/x-wav',
  'video/mp4',
])

/**
 * Upload bytes and return the public URL to pass as `image_url` / `video_url`.
 * The `upload_headers` from the presigned response go on the PUT verbatim (the
 * `x-amz-tagging` header is what marks the object temporary); the API key is
 * deliberately not sent to the storage host.
 */
export async function higgsfieldUpload(
  apiKey: string,
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<{ publicUrl: string }> {
  const create = await fetch(`${higgsfieldBase()}/files/generate-upload-url`, {
    method: 'POST',
    headers: headers(apiKey, true),
    body: JSON.stringify({ content_type: contentType }),
    signal,
  })
  if (!create.ok) await throwForResponse(create)

  const target = (await create.json().catch(() => null)) as {
    public_url?: string
    upload_url?: string
    upload_headers?: Record<string, string>
  } | null
  if (!target?.public_url || !target.upload_url) {
    throw new HiggsfieldError('Higgsfield returned no upload URL', 'http')
  }

  const put = await fetch(target.upload_url, {
    method: 'PUT',
    headers: { ...(target.upload_headers ?? {}), 'Content-Type': target.upload_headers?.['Content-Type'] ?? contentType },
    body: bytes as unknown as BodyInit,
    signal,
  })
  if (!put.ok) {
    const text = await put.text().catch(() => '')
    throw new HiggsfieldError(`Higgsfield upload failed (${put.status})${text ? `: ${text}` : ''}`, 'http')
  }
  return { publicUrl: target.public_url }
}

/** Turn a `data:` URI into a public URL; pass an http(s) URL through untouched. */
export async function higgsfieldEnsurePublicUrl(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  if (/^https:\/\//i.test(value)) return value
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) {
    throw new HiggsfieldError('Higgsfield inputs must be http(s) URLs or data URIs', 'validation')
  }
  const contentType = match[1] || 'application/octet-stream'
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]))
  const { publicUrl } = await higgsfieldUpload(apiKey, bytes, contentType, signal)
  return publicUrl
}

// -----------------------------------------------------------------------------
// Request shaping
// -----------------------------------------------------------------------------

export interface HiggsfieldPreset {
  id: string
  name: string
  previewUrl?: string
}

export async function higgsfieldPresets(apiKey: string, signal?: AbortSignal): Promise<HiggsfieldPreset[]> {
  const response = await fetch(`${higgsfieldBase()}${HIGGSFIELD_RESTYLE_PRESETS_PATH}`, {
    headers: headers(apiKey),
    signal,
  })
  if (!response.ok) await throwForResponse(response)
  const body = (await response.json().catch(() => null)) as {
    items?: Array<{ id?: string; name?: string; preview_url?: string }>
  } | null
  return (body?.items ?? [])
    .filter((item): item is { id: string; name?: string; preview_url?: string } => typeof item?.id === 'string')
    .map((item) => ({ id: item.id, name: item.name ?? item.id, previewUrl: item.preview_url }))
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function parseSize(size: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size || '')
  if (!match) return { width: 1024, height: 1024 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** The allowed ratio whose numeric value is closest to `size` (e.g. 1024x1792 → 9:16). */
export function nearestHiggsfieldAspectRatio(size: string | undefined, allowed: readonly string[]): string {
  if (allowed.length === 0) return '1:1'
  if (!size) {
    const square = allowed.find((r) => r === '1:1')
    return square ?? allowed[0]
  }
  const { width, height } = parseSize(size)
  const target = width / height
  let best = allowed[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const ratio of allowed) {
    const [w, h] = ratio.split(':').map(Number)
    if (!w || !h) continue
    const delta = Math.abs(w / h - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = ratio
    }
  }
  return best
}

export const SOUL_ASPECT_RATIOS = ['1:1', '9:16', '16:9', '4:3', '3:4', '2:3', '3:2'] as const
export const IDEOGRAM_ASPECT_RATIOS = ['1:1', '9:16', '16:9', '4:3', '3:4', '2:3', '3:2'] as const
export const QWEN_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9'] as const
export const Z_IMAGE_ASPECT_RATIOS = QWEN_ASPECT_RATIOS
export const RECRAFT_ASPECT_RATIOS = [
  '1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5',
  '6:10', '14:10', '10:14', '16:9', '9:16',
] as const
export const MARKETING_ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const
export const GROK_ASPECT_RATIOS = ['auto', '1:1', '1:2', '2:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] as const
export const ADS_STUDIO_ASPECT_RATIOS = [
  '1:1', '4:5', '5:4', '16:9', '9:16', '4:3', '3:4', '21:9',
  '3:2', '2:3', '2:1', '1:2', '3:1', '1:3',
] as const

/** Resolution tiers as `[standard, hd]`. SOUL calls them 720p/1080p. */
export const SOUL_RESOLUTIONS = ['720p', '1080p'] as const
export const IMAGE_RESOLUTIONS = ['1k', '2k'] as const
export const RECRAFT_1K_RESOLUTIONS = ['1k', '1k'] as const
export const RECRAFT_2K_RESOLUTIONS = ['2k', '2k'] as const

/**
 * How one Higgsfield image endpoint takes its documented body. This is a
 * table, not a branch: `buildHiggsfieldImageRequest` throws away the idea of
 * per-model if/else, and `check:higgsfield-docs` fails when a catalog entry is
 * missing from it, so a new model cannot ship without someone reading its
 * schema.
 */
export interface HiggsfieldImageShape {
  /** Documented `aspect_ratio` values, in the vendor's order. */
  aspectRatios: readonly string[]
  /** `[standard, hd]` resolution tiers. Omitted when the endpoint takes none. */
  resolutions?: readonly [string, string]
  /** `[standard, hd]` `quality` values. Omitted when the endpoint takes none. */
  qualities?: readonly [string, string]
  /** Extra quality tiers a caller may send and we pass through (flare/sunburst). */
  extendedQualities?: readonly string[]
  /** Documented reference-image field and whether it is an array. */
  references?: { field: string; multiple: boolean }
  /** Send `enhance_prompt: false` (SOUL family). */
  enhancePrompt?: boolean
  /** Send `batch_size: 1` (SOUL family). */
  batchSize?: boolean
  /** Send `rendering_speed` instead of `quality` (Ideogram). */
  renderingSpeed?: boolean
  /** Submit the entry's `editApiModel` when references are present (Qwen). */
  editWhenReferenced?: boolean
}

export const HIGGSFIELD_IMAGE_SHAPES: Record<string, HiggsfieldImageShape> = {
  'hf-soul-v2': {
    aspectRatios: SOUL_ASPECT_RATIOS, resolutions: SOUL_RESOLUTIONS, enhancePrompt: true, batchSize: true,
  },
  'hf-soul-standard': {
    aspectRatios: SOUL_ASPECT_RATIOS, resolutions: SOUL_RESOLUTIONS, enhancePrompt: true, batchSize: true,
    references: { field: 'image_reference_url', multiple: false },
  },
  'hf-soul-cinema': {
    aspectRatios: SOUL_ASPECT_RATIOS, resolutions: SOUL_RESOLUTIONS, enhancePrompt: true, batchSize: true,
  },
  'hf-ideogram-4': {
    aspectRatios: IDEOGRAM_ASPECT_RATIOS, renderingSpeed: true,
    references: { field: 'image_url', multiple: false },
  },
  'hf-qwen-image-3': {
    aspectRatios: QWEN_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS,
    references: { field: 'image_urls', multiple: true }, editWhenReferenced: true,
  },
  'hf-recraft-v4.1': { aspectRatios: RECRAFT_ASPECT_RATIOS, resolutions: RECRAFT_1K_RESOLUTIONS },
  'hf-recraft-v4.1-pro': { aspectRatios: RECRAFT_ASPECT_RATIOS, resolutions: RECRAFT_2K_RESOLUTIONS },
  'hf-recraft-v4.1-utility': { aspectRatios: RECRAFT_ASPECT_RATIOS, resolutions: RECRAFT_1K_RESOLUTIONS },
  'hf-recraft-v4.1-utility-pro': { aspectRatios: RECRAFT_ASPECT_RATIOS, resolutions: RECRAFT_2K_RESOLUTIONS },
  'hf-z-image-turbo': { aspectRatios: Z_IMAGE_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS },
  'hf-marketing-studio': {
    aspectRatios: MARKETING_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS, qualities: ['medium', 'high'],
    references: { field: 'image_urls', multiple: true },
  },
  'hf-marketing-studio-flare': {
    aspectRatios: MARKETING_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS, qualities: ['medium', 'high'],
    extendedQualities: ['xhigh', 'max'],
    references: { field: 'image_urls', multiple: true },
  },
  'hf-marketing-studio-sunburst': {
    aspectRatios: MARKETING_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS, qualities: ['medium', 'high'],
    extendedQualities: ['xhigh', 'max'],
    references: { field: 'image_urls', multiple: true },
  },
  'hf-grok-image-2': {
    // Grok only accepts low|medium, so both of our tiers send medium.
    aspectRatios: GROK_ASPECT_RATIOS, resolutions: IMAGE_RESOLUTIONS, qualities: ['medium', 'medium'],
    references: { field: 'image_urls', multiple: true },
  },
  'hf-ads-studio': {
    aspectRatios: ADS_STUDIO_ASPECT_RATIOS,
    references: { field: 'image_urls', multiple: true },
  },
}

export interface HiggsfieldImageParams {
  prompt: string
  size?: string
  quality?: string
  /** Public URLs of reference images (Higgsfield takes URLs only). */
  referenceUrls?: string[]
}

/** `hd`/`high`/`xhigh`/`max` pick the higher documented tier; the rest the lower. */
function imageQualityTier(quality: string | undefined): 0 | 1 {
  return quality && ['hd', 'high', 'xhigh', 'max'].includes(quality) ? 1 : 0
}

/**
 * One submission per image: the proxy fans out `n` copies and sums the
 * estimates. Every field sent here is one the vendor documents for that
 * endpoint — an undocumented extra is a 422, so the shape table decides.
 */
export function buildHiggsfieldImageRequest(
  entry: ImageModelEntry,
  params: HiggsfieldImageParams,
): { endpoint: string; input: Record<string, unknown> } {
  const shape = HIGGSFIELD_IMAGE_SHAPES[entry.id]
  const referenceUrls = params.referenceUrls ?? []
  const endpoint = shape?.editWhenReferenced && referenceUrls.length > 0 && entry.editApiModel
    ? entry.editApiModel
    : entry.apiModel

  // `prompt` is the only field every endpoint requires: a catalog entry with no
  // documented shape still produces a valid request instead of rejecting the
  // whole `list_media_models` call.
  if (!shape) return { endpoint, input: { prompt: params.prompt } }

  const tier = imageQualityTier(params.quality)
  const input: Record<string, unknown> = {
    prompt: params.prompt,
    aspect_ratio: nearestHiggsfieldAspectRatio(params.size, shape.aspectRatios),
  }
  if (shape.resolutions) input.resolution = shape.resolutions[tier]
  if (shape.qualities) {
    const extended = params.quality && shape.extendedQualities?.includes(params.quality)
    input.quality = extended ? params.quality : shape.qualities[tier]
  }
  if (shape.renderingSpeed) input.rendering_speed = tier === 1 ? 'QUALITY' : 'DEFAULT'
  if (shape.enhancePrompt) input.enhance_prompt = false
  if (shape.batchSize) input.batch_size = 1
  if (shape.references && referenceUrls.length > 0) {
    input[shape.references.field] = shape.references.multiple ? referenceUrls : referenceUrls[0]
  }
  return { endpoint, input }
}

export interface HiggsfieldVideoParams {
  prompt?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  /** Public URL of the first frame (image-to-video). */
  startImageUrl?: string
  /** Public URLs of character/object references. */
  referenceUrls?: string[]
  /** Public URL of the clip a Genjutsu workflow edits. */
  sourceVideoUrl?: string
  /** Restyle style UUID. */
  presetId?: string
}

/** Build the submit body for one video generation or Genjutsu edit. */
export function buildHiggsfieldVideoRequest(
  entry: VideoModelEntry,
  params: HiggsfieldVideoParams,
): { endpoint: string; input: Record<string, unknown> } {
  if (entry.genjutsu) {
    if (!params.sourceVideoUrl) {
      throw new HiggsfieldError(`${entry.displayName} needs a source video (source_video).`, 'validation')
    }
    const base: Record<string, unknown> = {
      video_url: params.sourceVideoUrl,
      image_urls: params.referenceUrls ?? [],
      ...(params.prompt ? { prompt: params.prompt } : {}),
      ...(params.resolution ? { resolution: params.resolution } : {}),
    }
    if (entry.genjutsu === 'restyle') {
      if (!params.presetId) {
        throw new HiggsfieldError('Genjutsu Restyle needs a preset_id — see the presets list.', 'validation')
      }
      return { endpoint: entry.textToVideoApiModel, input: { ...base, preset_id: params.presetId } }
    }
    return { endpoint: entry.textToVideoApiModel, input: base }
  }

  const imageToVideo = !!params.startImageUrl
  const endpoint = imageToVideo ? entry.imageToVideoApiModel : entry.textToVideoApiModel
  if (!endpoint) throw new HiggsfieldError(`${entry.displayName} does not support image-to-video`, 'validation')

  const input: Record<string, unknown> = {}
  if (params.prompt) input.prompt = params.prompt
  // Hailuo, Kling and Wan ignore anything but the documented fields; sending
  // an unsupported one is a 422, so each family only gets what it accepts.
  if (entry.id === 'hf-ltx-2.5-fast') {
    input.duration = params.duration ?? entry.defaultDuration
    input.resolution = params.resolution ?? entry.defaultResolution ?? '720p'
    if (params.aspectRatio) input.aspect_ratio = params.aspectRatio
  } else if (entry.id === 'hf-wan-2.6') {
    input.duration = params.duration ?? entry.defaultDuration
    input.resolution = params.resolution ?? entry.defaultResolution ?? '720p'
  } else {
    input.duration = params.duration ?? entry.defaultDuration
  }
  if (imageToVideo) input.image_url = params.startImageUrl
  return { endpoint, input }
}

/** Body for `POST /estimate/<endpoint>`: the submit body, minus input media we don't have yet. */
export function buildHiggsfieldEstimateBody(
  entry: ImageModelEntry | VideoModelEntry,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  const isVideo = 'textToVideoApiModel' in entry
  if (isVideo && (entry as VideoModelEntry).sourceVideo) return null
  return params
}
