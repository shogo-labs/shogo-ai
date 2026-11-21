// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project bucket client (SHO-491).
 *
 * ## Bytes
 *
 * `put()` streams: it asks the API for an upload ticket and sends the body
 * straight to object storage (cloud) or to the API's upload route (desktop).
 * Nothing buffers the whole file — a 500 MB video grows the process by one
 * 16 MiB part at a time, which is the same bar as SHO-478/485. Above 64 MiB the
 * API answers with a multipart ticket and `put()` uploads part by part.
 *
 * ## Errors
 *
 * The API's machine-readable `code` survives: `bucket_payment_required` (over
 * the workspace allowance and the workspace cannot pay) becomes a
 * {@link BucketPaymentRequiredError} carrying the reason, the numbers and the
 * Billing link to show the user; `key_exists` becomes a
 * {@link BucketKeyExistsError}. Both are `instanceof BucketError`, with
 * `status` and `code` set, so a route can map them to its own response without
 * parsing a string.
 */

import { readRuntimeAuthSecret } from '../runtime-token.js'

export interface BucketClientOptions {
  /** Base URL of the Shogo API (the pod's `SHOGO_API_URL`). */
  apiUrl: string
  /** The project whose bucket this is. */
  projectId: string
  /** Pod-native credential. Defaults to `process.env.RUNTIME_AUTH_SECRET`. */
  runtimeToken?: string | null
  /** `shogo_sk_*` credential for code running outside a pod. */
  shogoApiKey?: string | null
  /** Override the public URL base (the CDN base on cloud). */
  cdnBaseUrl?: string
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch
}

export interface BucketUploadTicket {
  uploadId: string
  key: string
  visibility: 'public' | 'private'
  mode: 'single' | 'multipart'
  url: string
  method: 'PUT'
  headers: Record<string, string>
  parts?: Array<{ partNumber: number; url: string }>
  partSize?: number
  completeUrl: string
  publicUrl: string | null
}

export interface BucketUploadRequest {
  key: string
  size: number
  contentType?: string
  /** Default true: public objects are what the CDN serves. */
  public?: boolean
  visibility?: 'public' | 'private'
  /** Replace an existing key instead of failing with `key_exists`. */
  overwrite?: boolean
}

export interface BucketPutOptions {
  /** Default true. */
  public?: boolean
  visibility?: 'public' | 'private'
  /** Defaults to `input.type` for a Blob/File. */
  contentType?: string
  overwrite?: boolean
}

export interface BucketPutResult {
  key: string
  size: number
  etag: string | null
  visibility: 'public' | 'private'
  /** The CDN URL for a public object, null for a private one. */
  url: string | null
}

export interface BucketListedObject {
  key: string
  visibility: 'public' | 'private'
  size: number
  contentType: string | null
  etag: string | null
  sha256: string | null
  updatedAt: string
}

export interface BucketListOptions {
  prefix?: string
  visibility?: 'public' | 'private'
  cursor?: string
  limit?: number
}

export interface BucketListPage {
  objects: BucketListedObject[]
  cursor: string | null
}

export interface BucketUsage {
  projectBytes: number
  projectObjects: number
  workspaceId: string
  workspaceUsedBytes: number
  allowanceBytes: number
  billingMode: 'shadow' | 'enforce'
  usdPerGbMonth: number
  publicBaseUrl: string
}

export interface BucketDeleteResult {
  key: string
  visibility: 'public' | 'private'
}

/** Anything the bucket API refused, with its `code` and HTTP status intact. */
export class BucketError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown> | null
  constructor(code: string, message: string, status: number, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'BucketError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** `402 bucket_payment_required` — over the allowance and the workspace can't pay. */
export class BucketPaymentRequiredError extends BucketError {
  readonly reason: string
  readonly usedBytes: number
  readonly allowanceBytes: number
  readonly usdPerGbMonth: number
  readonly billingUrl: string | null
  constructor(error: { message: string; reason?: string; usedBytes?: number; allowanceBytes?: number; usdPerGbMonth?: number; billingUrl?: string }) {
    super('bucket_payment_required', error.message, 402, error as Record<string, unknown>)
    this.name = 'BucketPaymentRequiredError'
    this.reason = error.reason ?? 'usage_limit_reached'
    this.usedBytes = Number(error.usedBytes ?? 0)
    this.allowanceBytes = Number(error.allowanceBytes ?? 0)
    this.usdPerGbMonth = Number(error.usdPerGbMonth ?? 0)
    this.billingUrl = error.billingUrl ?? null
  }
}

/** `409 key_exists` — pass `overwrite: true` to replace the object. */
export class BucketKeyExistsError extends BucketError {
  constructor(message: string) {
    super('key_exists', message, 409)
    this.name = 'BucketKeyExistsError'
  }
}

/** `503 bucket_not_configured` — this deployment has no object storage. */
export class BucketNotConfiguredError extends BucketError {
  constructor(message: string) {
    super('bucket_not_configured', message, 503)
    this.name = 'BucketNotConfiguredError'
  }
}

const MULTIPART_PART_SIZE = 16 * 1024 * 1024

type PutInput = Blob | ArrayBufferLike | Uint8Array | ReadableStream<Uint8Array>

export class BucketClient {
  private readonly apiUrl: string
  private readonly projectId: string
  private readonly runtimeToken: string | null
  private readonly shogoApiKey: string | null
  private readonly fetchImpl: typeof fetch
  /** Resolved from `/usage` on the first call; `url()` uses it once known. */
  private cdnBaseUrl: string | null

  constructor(options: BucketClientOptions) {
    if (!options?.projectId) {
      throw new Error('shogo.bucket requires a projectId (createClient({ projectId }))')
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, '')
    this.projectId = options.projectId
    // `undefined` means "use the pod's secret"; an explicit `null` means "no
    // runtime token", so a caller that only has a Shogo API key is not
    // shadowed by an ambient RUNTIME_AUTH_SECRET in its environment.
    this.runtimeToken =
      options.runtimeToken === undefined ? readRuntimeAuthSecret() ?? null : options.runtimeToken
    this.shogoApiKey = options.shogoApiKey ?? null
    this.fetchImpl = options.fetch ?? fetch
    const configuredBase =
      options.cdnBaseUrl ?? (typeof process !== 'undefined' ? process.env?.SHOGO_BUCKET_CDN_BASE : undefined)
    this.cdnBaseUrl = configuredBase ? configuredBase.replace(/\/+$/, '') : null
    if (!this.runtimeToken && !this.shogoApiKey) {
      throw new Error(
        'shogo.bucket needs a credential: RUNTIME_AUTH_SECRET (pod) or shogoApiKey (outside a pod)',
      )
    }
  }

  // -------------------------------------------------------------------------
  // URLs
  // -------------------------------------------------------------------------

  /**
   * The URL a public object is served at. Synchronous — no network call — so
   * it can be used while rendering. Before the first API call the base is
   * unknown (a pod has no idea which CDN host serves this deployment), so this
   * answers the API's own redirect URL, which 302s to the CDN. Every async
   * call refreshes the base from the API, so after the first `put`/`list`/
   * `usage` this returns the CDN URL directly.
   */
  url(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/')
    if (this.cdnBaseUrl) return `${this.cdnBaseUrl}/${encodeURIComponent(this.projectId)}/${encoded}`
    return `${this.apiUrl}/api/projects/${this.projectId}/bucket/objects/${encoded}`
  }

  /** A short-lived read URL. Public objects answer their CDN URL. */
  async signedUrl(key: string, options: { expiresIn?: number; public?: boolean } = {}): Promise<string> {
    const visibility = options.public === false ? 'private' : 'public'
    const query = new URLSearchParams({ url: '1', visibility, expiresIn: String(options.expiresIn ?? 3600) })
    const response = await this.request(`/bucket/objects/${encodeKey(key)}?${query}`)
    const body = (await response.json()) as { url: string }
    return body.url
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /** Mint an upload ticket (for a browser upload from the app's own route). */
  async createUpload(request: BucketUploadRequest): Promise<BucketUploadTicket> {
    const visibility = request.visibility ?? (request.public === false ? 'private' : 'public')
    const response = await this.request('/bucket/uploads', {
      method: 'POST',
      body: JSON.stringify({
        key: request.key,
        size: request.size,
        contentType: request.contentType,
        visibility,
        overwrite: request.overwrite === true,
      }),
      headers: { 'content-type': 'application/json' },
    })
    const ticket = (await response.json()) as BucketUploadTicket
    this.noteBase(ticket.publicUrl)
    return ticket
  }

  /** Finish an upload: index the object. */
  async complete(
    ticket: Pick<BucketUploadTicket, 'uploadId'>,
    parts: Array<{ ETag: string; PartNumber: number }> = [],
  ): Promise<BucketPutResult> {
    const response = await this.request(`/bucket/uploads/${ticket.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
      headers: { 'content-type': 'application/json' },
    })
    const stored = (await response.json()) as {
      key: string
      size: number
      etag: string | null
      visibility: 'public' | 'private'
      publicUrl: string | null
    }
    this.noteBase(stored.publicUrl)
    return {
      key: stored.key,
      size: stored.size,
      etag: stored.etag,
      visibility: stored.visibility,
      url: stored.publicUrl,
    }
  }

  /**
   * Upload one object, streaming it.
   *
   * A `Blob`/`File` knows its size and type; a raw stream does not, so it is
   * always a single-part upload whose size is recorded from the stored object.
   */
  async put(key: string, input: PutInput, options: BucketPutOptions = {}): Promise<BucketPutResult> {
    const visibility = options.visibility ?? (options.public === false ? 'private' : 'public')
    const contentType = options.contentType ?? (isBlob(input) ? input.type || undefined : undefined)
    const size = knownSize(input)
    const ticket = await this.createUpload({
      key,
      size: size ?? 0,
      contentType,
      visibility,
      overwrite: options.overwrite,
    })

    try {
      const parts: Array<{ ETag: string; PartNumber: number }> = []
      if (ticket.mode === 'multipart' && ticket.parts?.length && isBlob(input)) {
        const partSize = ticket.partSize ?? MULTIPART_PART_SIZE
        for (const part of ticket.parts) {
          const start = (part.partNumber - 1) * partSize
          const slice = input.slice(start, Math.min(start + partSize, input.size))
          const response = await this.fetchImpl(part.url, { method: 'PUT', body: slice })
          if (!response.ok) throw await this.httpError(response)
          const etag = response.headers.get('etag')
          if (!etag) throw new BucketError('upload_failed', 'object storage returned no ETag for a part', 502)
          parts.push({ ETag: etag, PartNumber: part.partNumber })
        }
      } else {
        const body = (
          isBlob(input)
            ? input
            : input instanceof Uint8Array
              ? input.slice()
              : input instanceof ArrayBuffer
                ? input
                : input
        ) as unknown as BodyInit
        const response = await this.fetchImpl(ticket.url, {
          method: 'PUT',
          body,
          headers: ticket.headers,
          // Node needs this for a streamed body; Bun ignores it.
          ...(typeof (input as any)?.getReader === 'function'
            ? ({ duplex: 'half' } as Record<string, unknown>)
            : {}),
        } as RequestInit)
        if (!response.ok) throw await this.httpError(response)
      }
      return await this.complete(ticket, parts)
    } catch (error) {
      // Nothing was indexed, so the ticket is dead weight: release a multipart
      // upload the provider is still holding.
      await this.request(`/bucket/uploads/${ticket.uploadId}`, { method: 'DELETE' }).catch(() => {})
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Read / list / delete / usage
  // -------------------------------------------------------------------------

  async list(options: BucketListOptions = {}): Promise<BucketListPage> {
    const query = new URLSearchParams()
    if (options.prefix) query.set('prefix', options.prefix)
    if (options.visibility) query.set('visibility', options.visibility)
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.limit) query.set('limit', String(options.limit))
    const response = await this.request(`/bucket/objects${query.size ? `?${query}` : ''}`)
    const body = (await response.json()) as BucketListPage & { publicBaseUrl?: string }
    this.noteBaseFromApi(body.publicBaseUrl)
    return { objects: body.objects, cursor: body.cursor }
  }

  async delete(key: string, options: { public?: boolean; visibility?: 'public' | 'private' } = {}): Promise<BucketDeleteResult> {
    const visibility = options.visibility ?? (options.public === false ? 'private' : 'public')
    const response = await this.request(`/bucket/objects/${encodeKey(key)}?visibility=${visibility}`, {
      method: 'DELETE',
    })
    const body = (await response.json()) as { key: string; visibility: 'public' | 'private' }
    return { key: body.key, visibility: body.visibility }
  }

  /** Project bytes, the workspace's usage and allowance, the rate and mode. */
  async usage(): Promise<BucketUsage> {
    const response = await this.request('/bucket/usage')
    const body = (await response.json()) as BucketUsage
    this.noteBaseFromApi(body.publicBaseUrl)
    return body
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.runtimeToken) headers.set('x-runtime-token', this.runtimeToken)
    else if (this.shogoApiKey) headers.set('authorization', `Bearer ${this.shogoApiKey}`)
    const response = await this.fetchImpl(`${this.apiUrl}/api/projects/${this.projectId}${path}`, {
      ...init,
      headers,
    })
    if (!response.ok) throw await this.httpError(response)
    return response
  }

  /** Turn the API's `{ error: { code, message, … } }` into a typed error. */
  private async httpError(response: Response): Promise<BucketError> {
    let body: any = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const error = body?.error ?? {}
    const code = typeof error.code === 'string' ? error.code : `http_${response.status}`
    const message =
      typeof error.message === 'string' ? error.message : `Bucket request failed (${response.status})`
    if (code === 'bucket_payment_required') return new BucketPaymentRequiredError({ ...error, message })
    if (code === 'key_exists') return new BucketKeyExistsError(message)
    if (code === 'bucket_not_configured') return new BucketNotConfiguredError(message)
    return new BucketError(code, message, response.status, error)
  }

  /** Remember the CDN base from a public object's URL. */
  private noteBase(publicUrl: string | null): void {
    if (!publicUrl) return
    const at = publicUrl.indexOf(`/${this.projectId}/`)
    if (at <= 0) return
    this.cdnBaseUrl = publicUrl.slice(0, at)
  }

  private noteBaseFromApi(base: string | undefined): void {
    if (!base) return
    // The API answers its own origin on desktop, where there is no CDN; using
    // it as the base still gives a working `/api/bucket/...` URL.
    this.cdnBaseUrl = base.replace(/\/+$/, '')
  }
}

function isBlob(input: PutInput): input is Blob {
  return typeof Blob !== 'undefined' && input instanceof Blob
}

function knownSize(input: PutInput): number | null {
  if (isBlob(input)) return input.size
  if (input instanceof Uint8Array) return input.byteLength
  if (input instanceof ArrayBuffer) return input.byteLength
  return null
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}
