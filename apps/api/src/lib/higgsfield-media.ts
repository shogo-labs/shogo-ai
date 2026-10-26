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

import type { ImageModelEntry, ModelOptionField, VideoModelEntry } from '@shogo/model-catalog'
import { optionsForEndpoint } from '@shogo/model-catalog'

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
  /** A caller-supplied value the endpoint's schema does not allow. */
  | 'invalid_option'
  /** A caller-supplied field the endpoint does not document. */
  | 'option_unsupported'
  /** A shared argument the model does not have, or a value outside its range. */
  | 'invalid_duration'
  | 'invalid_resolution'
  | 'invalid_aspect_ratio'
  | 'audio_not_supported'
  | 'image_to_video_unsupported'
  | 'text_to_video_unsupported'
  | 'reference_images_unsupported'
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

/**
 * The bytes behind a provider output URL (or a data URI), base64-encoded, for
 * the OpenAI-shaped routes that answer with `b64_json`.
 */
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
  if (!response.ok) throw new HiggsfieldError(`Downloading the output failed (${response.status})`, 'http', response.status)
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  return { b64: Buffer.from(await response.arrayBuffer()).toString('base64'), contentType }
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
// Presets and size helpers
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

// -----------------------------------------------------------------------------
// Request shaping
//
// The bodies are declarative: the generated catalog already says what each
// endpoint accepts (enum, range, step, default), so the builder maps the
// arguments every model shares onto whatever field names this endpoint
// documents, passes model-specific fields through from `options`, and validates
// every value against the vendor's own schema. Nothing is sent that the
// endpoint does not declare (the vendor answers 422 for those), and nothing the
// caller asked for is dropped silently.
// -----------------------------------------------------------------------------

type MediaEntry = ImageModelEntry | VideoModelEntry

function fail(message: string, code: HiggsfieldErrorCode): never {
  throw new HiggsfieldError(message, code)
}

/** `3–15` / `6, 10` — how an allowed set reads in an error. */
function describeAllowed(field: ModelOptionField): string {
  if (field.enum && field.enum.length > 0) return field.enum.join(', ')
  if (field.type === 'integer' || field.type === 'number') {
    if (field.minimum !== undefined && field.maximum !== undefined) return `${field.minimum}–${field.maximum}`
    if (field.minimum !== undefined) return `>= ${field.minimum}`
    if (field.maximum !== undefined) return `<= ${field.maximum}`
  }
  return field.type
}

function describeField(field: ModelOptionField): string {
  const label = field.title ? `${field.title} (${field.name})` : field.name
  return `${label}: ${describeAllowed(field)}`
}

/**
 * Check one value against the field's documented constraints, returning what to
 * send. Numbers accept numeric strings; enums compare as strings so an integer
 * enum (`batch_size: 1 | 4`) validates too.
 */
export function checkOptionValue(
  entry: MediaEntry,
  endpoint: string,
  field: ModelOptionField,
  value: unknown,
): unknown {
  const where = `${entry.id} (${endpoint})`

  if (field.enum && field.enum.length > 0) {
    const asText = String(value)
    if (!field.enum.includes(asText)) {
      fail(`${field.name} must be one of ${describeAllowed(field)} for ${where}; got ${JSON.stringify(value)}.`, 'invalid_option')
    }
    return field.type === 'integer' || field.type === 'number' ? Number(asText) : asText
  }

  if (field.type === 'integer' || field.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (typeof value === 'boolean' || !Number.isFinite(numeric)) {
      fail(`${field.name} must be a ${field.type} for ${where}; got ${JSON.stringify(value)}.`, 'invalid_option')
    }
    if (field.type === 'integer' && !Number.isInteger(numeric)) {
      fail(`${field.name} must be a whole number for ${where}; got ${numeric}.`, 'invalid_option')
    }
    if (field.minimum !== undefined && numeric < field.minimum) {
      fail(`${field.name} must be ${describeAllowed(field)} for ${where}; got ${numeric}.`, 'invalid_option')
    }
    if (field.maximum !== undefined && numeric > field.maximum) {
      fail(`${field.name} must be ${describeAllowed(field)} for ${where}; got ${numeric}.`, 'invalid_option')
    }
    if (field.multipleOf && Math.abs(Math.round(numeric / field.multipleOf) * field.multipleOf - numeric) > 1e-9) {
      fail(`${field.name} must be a multiple of ${field.multipleOf} for ${where}; got ${numeric}.`, 'invalid_option')
    }
    return numeric
  }

  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      fail(`${field.name} must be true or false for ${where}; got ${JSON.stringify(value)}.`, 'invalid_option')
    }
    return value
  }

  if (field.type === 'array') {
    if (!Array.isArray(value)) {
      fail(`${field.name} must be an array for ${where}.`, 'invalid_option')
    }
    if (field.minItems !== undefined && value.length < field.minItems) {
      fail(`${field.name} needs at least ${field.minItems} item(s) for ${where}.`, 'invalid_option')
    }
    if (field.maxItems !== undefined && value.length > field.maxItems) {
      fail(`${field.name} takes at most ${field.maxItems} item(s) for ${where}.`, 'invalid_option')
    }
    if (field.itemFields) {
      return value.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          fail(`${field.name}[${index}] must be an object for ${where}.`, 'invalid_option')
        }
        const out: Record<string, unknown> = {}
        for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
          const spec = field.itemFields![key]
          if (!spec) {
            fail(
              `${field.name}[${index}] has no field '${key}' for ${where}; allowed: ${Object.keys(field.itemFields!).join(', ')}.`,
              'invalid_option',
            )
          }
          out[key] = checkOptionValue(entry, endpoint, spec, nested)
        }
        return out
      })
    }
    if (field.items && field.items !== 'any') {
      return value.map((item, index) => {
        if (field.items === 'string' && typeof item !== 'string') {
          fail(`${field.name}[${index}] must be a string for ${where}.`, 'invalid_option')
        }
        return item
      })
    }
    return value
  }

  if (field.type === 'string') {
    if (typeof value !== 'string') {
      fail(`${field.name} must be a string for ${where}; got ${JSON.stringify(value)}.`, 'invalid_option')
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      fail(`${field.name} is limited to ${field.maxLength} characters for ${where}.`, 'invalid_option')
    }
    return value
  }

  return value
}

function optionFor(entry: MediaEntry, endpoint: string, name: string): ModelOptionField | undefined {
  return optionsForEndpoint(entry, endpoint).find((field) => field.name === name)
}

/**
 * First documented field among `names` — how the shared argument names
 * (`audio` → `sound` | `generate_audio`, `start_image` → `image_url` | …) find
 * the endpoint's own spelling.
 */
function firstDeclared(entry: MediaEntry, endpoint: string, names: readonly string[]): string | undefined {
  return names.find((name) => !!optionFor(entry, endpoint, name))
}

function setField(
  entry: MediaEntry,
  endpoint: string,
  input: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  const field = optionFor(entry, endpoint, name)
  if (!field) {
    fail(
      `${entry.id} does not take '${name}' on ${endpoint}. Supported fields: ${optionsForEndpoint(entry, endpoint).map((option) => option.name).join(', ') || 'none'}.`,
      'option_unsupported',
    )
  }
  input[name] = checkOptionValue(entry, endpoint, field, value)
}

/**
 * The arguments every model shares (`duration`, `aspect_ratio`, `resolution`)
 * get their own error code when the model does not have the field at all, so a
 * caller can tell "this model has no aspect ratio" (fix: drop it) from "that
 * value is not allowed" (fix: use another value).
 */
function setShared(
  entry: MediaEntry,
  endpoint: string,
  input: Record<string, unknown>,
  name: string,
  value: unknown,
  code: HiggsfieldErrorCode,
  hint?: string,
): void {
  if (!optionFor(entry, endpoint, name)) {
    const supported = optionsForEndpoint(entry, endpoint).map((option) => option.name)
    fail(
      `${entry.displayName} has no ${name}${hint ? ` — ${hint}` : ''}. Supported fields: ${supported.join(', ') || 'none'}.`,
      code,
    )
  }
  try {
    setField(entry, endpoint, input, name, value)
  } catch (error) {
    // Re-code an out-of-range / not-allowed value so the caller learns which
    // argument was wrong, not just that something was.
    if (error instanceof HiggsfieldError && error.code === 'invalid_option') {
      throw new HiggsfieldError(error.message, code)
    }
    throw error
  }
}

/** Apply the caller's model-specific `options`, rejecting anything undeclared. */
function applyOptions(
  entry: MediaEntry,
  endpoint: string,
  input: Record<string, unknown>,
  options: Record<string, unknown> | undefined,
): void {
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === undefined) continue
    setField(entry, endpoint, input, name, value)
  }
}

/** The declared field that carries an input array of reference images. */
function referenceArrayField(entry: MediaEntry, endpoint: string): ModelOptionField | undefined {
  return optionsForEndpoint(entry, endpoint).find(
    (field) => field.type === 'array' && /image/i.test(field.name),
  )
}

export interface HiggsfieldImageParams {
  prompt: string
  size?: string
  quality?: string
  /** Public URLs of reference images (Higgsfield takes URLs only). */
  referenceUrls?: string[]
  /** Model-specific documented fields (`seed`, `negative_prompt`, `style_id`, …). */
  options?: Record<string, unknown>
}

/** `hd`/`high`/`xhigh`/`max` pick the higher documented tier; the rest the lower. */
function highTier(quality: string | undefined): boolean {
  return !!quality && ['hd', 'high', 'xhigh', 'max'].includes(quality)
}

/**
 * One submission per image: the proxy fans out `n` copies and sums the
 * estimates, so `batch_size` stays at its documented default of one.
 */
export function buildHiggsfieldImageRequest(
  entry: ImageModelEntry,
  params: HiggsfieldImageParams,
): { endpoint: string; input: Record<string, unknown> } {
  const referenceUrls = params.referenceUrls ?? []
  const declaredReferences = entry.referenceField
    ? !!optionFor(entry, entry.apiModel, entry.referenceField.name)
    : false
  // A model whose reference field lives on a separate endpoint (Qwen) switches
  // to it only when there are references to send.
  const endpoint = referenceUrls.length > 0 && entry.editApiModel && !declaredReferences
    ? entry.editApiModel
    : entry.apiModel

  if (referenceUrls.length > 0 && !entry.referenceField) {
    fail(`${entry.id} does not accept reference images. Call list_media_models to find one that does.`, 'reference_images_unsupported')
  }

  const input: Record<string, unknown> = {}
  setField(entry, endpoint, input, 'prompt', params.prompt)

  const aspect = optionFor(entry, endpoint, 'aspect_ratio')
  if (aspect?.enum && aspect.enum.length > 0) {
    input.aspect_ratio = nearestHiggsfieldAspectRatio(params.size, aspect.enum)
  }

  if (entry.quality) {
    const target = highTier(params.quality) ? entry.quality.hd : entry.quality.standard
    setField(entry, endpoint, input, entry.quality.field, target)
  } else {
    const qualityField = optionFor(entry, endpoint, 'quality')
    if (qualityField?.enum && qualityField.enum.length > 0) {
      const requested = params.quality ?? 'standard'
      const target = qualityField.enum.includes(requested)
        ? requested
        : highTier(requested)
          ? (qualityField.enum.find((value) => value === 'high') ?? qualityField.enum[qualityField.enum.length - 1])
          : (qualityField.enum.find((value) => value === 'medium') ?? qualityField.enum[0])
      setField(entry, endpoint, input, 'quality', target)
    }
  }

  const resolution = optionFor(entry, endpoint, 'resolution')
  if (resolution?.enum && resolution.enum.length > 0) {
    const tier = highTier(params.quality) ? 1 : 0
    const index = Math.min(tier, resolution.enum.length - 1)
    setField(entry, endpoint, input, 'resolution', resolution.enum[index])
  }

  if (referenceUrls.length > 0 && entry.referenceField) {
    setField(
      entry,
      endpoint,
      input,
      entry.referenceField.name,
      entry.referenceField.multiple ? referenceUrls : referenceUrls[0],
    )
  }

  // Our contract is one image per request (the proxy fans out `n` copies and
  // sums the estimates), so `batch_size` is pinned to 1 wherever the endpoint
  // documents it — including endpoints whose schema states no default.
  if (optionFor(entry, endpoint, 'batch_size')) setField(entry, endpoint, input, 'batch_size', 1)
  // Prompt enhancement rewrites the prompt and changes the output (and, at some
  // vendors, the price), so it is sent at its documented default rather than
  // left to whichever default the vendor may adopt later.
  const enhance = optionFor(entry, endpoint, 'enhance_prompt')
  if (enhance && enhance.default !== undefined) {
    setField(entry, endpoint, input, 'enhance_prompt', enhance.default)
  }

  applyOptions(entry, endpoint, input, params.options)

  if (input.batch_size !== undefined && Number(input.batch_size) !== 1) {
    fail(
      `batch_size is always 1 for ${entry.id}: ask for several images with the options count instead.`,
      'invalid_option',
    )
  }
  return { endpoint, input }
}

export interface HiggsfieldVideoParams {
  prompt?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  /** Native audio on/off. Errors as `audio_not_supported` when the model has no audio field. */
  audio?: boolean
  /** Public URL of the first frame (image-to-video). */
  startImageUrl?: string
  /** Public URLs of character/object references. */
  referenceUrls?: string[]
  /** Public URL of the clip a Genjutsu workflow edits. */
  sourceVideoUrl?: string
  /** Restyle style UUID. */
  presetId?: string
  /** Model-specific documented fields (`cfg_scale`, `multi_shots`, `multi_prompt`, …). */
  options?: Record<string, unknown>
}

/** Build the submit body for one video generation or Genjutsu edit. */
export function buildHiggsfieldVideoRequest(
  entry: VideoModelEntry,
  params: HiggsfieldVideoParams,
): { endpoint: string; input: Record<string, unknown> } {
  if (entry.sourceVideo) {
    if (!params.sourceVideoUrl) {
      fail(`${entry.displayName} needs a source video (source_video).`, 'validation')
    }
    const endpoint = entry.textToVideoApiModel ?? entry.endpoints?.[0]
    if (!endpoint) fail(`${entry.displayName} has no endpoint.`, 'validation')
    const input: Record<string, unknown> = {}
    setField(entry, endpoint, input, 'video_url', params.sourceVideoUrl)
    if (params.prompt) setField(entry, endpoint, input, 'prompt', params.prompt)
    if (params.resolution) setField(entry, endpoint, input, 'resolution', params.resolution)
    if (params.referenceUrls && params.referenceUrls.length > 0) {
      setField(entry, endpoint, input, 'image_urls', params.referenceUrls)
    }
    if (entry.genjutsu === 'restyle') {
      if (!params.presetId) {
        fail('Genjutsu Restyle needs a preset_id — see the presets list.', 'validation')
      }
      setField(entry, endpoint, input, 'preset_id', params.presetId)
    }
    applyOptions(entry, endpoint, input, params.options)
    return { endpoint, input }
  }

  const wantsImage = !!params.startImageUrl
  const endpoint = wantsImage ? entry.imageToVideoApiModel : entry.textToVideoApiModel
  if (!endpoint) {
    fail(
      wantsImage
        ? `${entry.displayName} does not support image-to-video.`
        : `${entry.displayName} generates from an image only — pass start_image.`,
      wantsImage ? 'image_to_video_unsupported' : 'text_to_video_unsupported',
    )
  }

  const input: Record<string, unknown> = {}
  if (params.prompt) setField(entry, endpoint, input, 'prompt', params.prompt)
  if (params.duration !== undefined) setShared(entry, endpoint, input, 'duration', params.duration, 'invalid_duration')
  if (params.aspectRatio) {
    setShared(entry, endpoint, input, 'aspect_ratio', params.aspectRatio, 'invalid_aspect_ratio', 'output framing follows the start image')
  }
  if (params.resolution) {
    setShared(entry, endpoint, input, 'resolution', params.resolution, 'invalid_resolution', 'it has a fixed resolution')
  }

  if (params.audio !== undefined) {
    const sound = optionFor(entry, endpoint, 'sound')
    const generateAudio = optionFor(entry, endpoint, 'generate_audio')
    if (sound) {
      setField(entry, endpoint, input, 'sound', params.audio ? sound.enum?.[0] ?? 'on' : sound.enum?.[1] ?? 'off')
    } else if (generateAudio) {
      setField(entry, endpoint, input, 'generate_audio', params.audio)
    } else if (params.audio) {
      fail(
        `${entry.displayName} has no native audio — pick a model with audio, or drop audio.`,
        'audio_not_supported',
      )
    }
  }

  if (params.startImageUrl) {
    const imageField = firstDeclared(entry, endpoint, ['image_url', 'start_image', 'image'])
    if (!imageField) {
      fail(`${entry.displayName} does not take a start image on ${endpoint}.`, 'image_to_video_unsupported')
    }
    setField(entry, endpoint, input, imageField, params.startImageUrl)
  }

  const references = params.referenceUrls ?? []
  if (references.length > 0) {
    const field = entry.maxReferenceImages > 0 ? referenceArrayField(entry, endpoint) : undefined
    if (!field) {
      fail(`${entry.displayName} does not accept reference images.`, 'reference_images_unsupported')
    }
    setField(entry, endpoint, input, field.name, references)
  }

  applyOptions(entry, endpoint, input, params.options)
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
