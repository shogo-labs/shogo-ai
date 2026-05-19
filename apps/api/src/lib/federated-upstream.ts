// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Federated Upstream — pass instance traffic through to the cloud the
 * local-mode API is already signed in to.
 *
 * Local mode (SHOGO_LOCAL_MODE=true) already maintains an authenticated
 * session against a single cloud endpoint:
 *
 *   - URL:        `getShogoCloudUrl()` (env-pinned, see lib/cloud-urls.ts)
 *   - Credential: `process.env.SHOGO_API_KEY`, populated by
 *                 `PUT /api/local/shogo-key` (server.ts) and persisted
 *                 to `localConfig.SHOGO_API_KEY` (see routes/local-auth.ts).
 *
 * The same credential drives the AI proxy and the instance-tunnel
 * client. This module reuses it to act as a *consumer* of cloud-side
 * instance endpoints — so a worker registered against staging can be
 * listed and driven from `localhost:8002` without re-registering.
 *
 * Public surface:
 *   isFederatedEnabled()           — gate; respects SHOGO_LOCAL_MODE.
 *   listCloudInstancesForWorkspace(workspaceId)
 *   lookupCloudInstance(id)        — 60s LRU cache; evicts on 401/404.
 *   forwardToUpstream(c, opts?)    — pipe a Hono request through to cloud,
 *                                    returning the raw fetch Response so
 *                                    callers can buffer or stream.
 *   onUpstreamRejection(handler)   — observe 401s so the existing
 *                                    cloudKeyRejected banner can flip.
 */

import type { Context } from 'hono'
import { prisma } from './prisma'
import { getShogoCloudUrl } from './cloud-urls'

// ─── Auth + gate ────────────────────────────────────────────────────────────

const CREDENTIAL_TTL_MS = 30_000
let cachedCredential: { value: string | null; expiresAt: number } | null = null
let cachedCloudWorkspaceId: { value: string | null; expiresAt: number } | null = null

/**
 * Resolve the cloud credential local mode uses. Reads `process.env`
 * first (populated by `PUT /api/local/shogo-key` and the auto-load in
 * server.ts), falling back to a prisma read of `localConfig.SHOGO_API_KEY`
 * for the narrow window where the env var has been cleared but the row
 * is still authoritative. Short TTL keeps the fallback cheap.
 */
export async function getUpstreamCredential(): Promise<string | null> {
  const envKey = process.env.SHOGO_API_KEY
  if (envKey) return envKey

  const now = Date.now()
  if (cachedCredential && cachedCredential.expiresAt > now) {
    return cachedCredential.value
  }

  let value: string | null = null
  try {
    const row = await (prisma as any).localConfig
      .findUnique({ where: { key: 'SHOGO_API_KEY' } })
      .catch(() => null)
    value = row?.value || null
  } catch {
    value = null
  }
  cachedCredential = { value, expiresAt: now + CREDENTIAL_TTL_MS }
  return value
}

/** Test-only: drop the credential cache. */
export function _resetUpstreamCredentialCache(): void {
  cachedCredential = null
  cachedCloudWorkspaceId = null
}

/**
 * Resolve the *cloud* workspace ID the local SHOGO_API_KEY is scoped to,
 * persisted as `localConfig.SHOGO_KEY_INFO` by `PUT /api/local/shogo-key`
 * (see server.ts). The local app's Better Auth workspace IDs do not
 * match cloud workspace IDs in general — staging will reject any list
 * call that passes a foreign workspace ID, so we translate before
 * forwarding `GET /api/instances?workspaceId=...`.
 */
export async function getUpstreamWorkspaceId(): Promise<string | null> {
  const now = Date.now()
  if (cachedCloudWorkspaceId && cachedCloudWorkspaceId.expiresAt > now) {
    return cachedCloudWorkspaceId.value
  }
  let value: string | null = null
  try {
    const row = await (prisma as any).localConfig
      .findUnique({ where: { key: 'SHOGO_KEY_INFO' } })
      .catch(() => null)
    if (row?.value) {
      try {
        const info = JSON.parse(row.value)
        const id = info?.workspace?.id
        if (typeof id === 'string' && id) value = id
      } catch { /* malformed json; treat as unset */ }
    }
  } catch {
    value = null
  }
  cachedCloudWorkspaceId = { value, expiresAt: now + CREDENTIAL_TTL_MS }
  return value
}

/** Federation is on when local mode is active and we have a credential. */
export function isLocalMode(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true'
}

export async function isFederatedEnabled(): Promise<boolean> {
  if (!isLocalMode()) return false
  const key = await getUpstreamCredential()
  return !!key
}

/** Hostname of the configured upstream, used as the `origin` tag on
 *  federated instance rows. */
export function getUpstreamOrigin(): string {
  try {
    return new URL(getShogoCloudUrl()).host
  } catch {
    return getShogoCloudUrl()
  }
}

// ─── 401 observer (wires into the existing cloudKeyRejected banner) ─────────

type RejectionHandler = (reason: string) => void
const rejectionHandlers = new Set<RejectionHandler>()

export function onUpstreamRejection(handler: RejectionHandler): () => void {
  rejectionHandlers.add(handler)
  return () => rejectionHandlers.delete(handler)
}

function notifyRejection(reason: string): void {
  for (const handler of rejectionHandlers) {
    try { handler(reason) } catch { /* observer threw; ignore */ }
  }
}

// ─── Instance lookup cache ──────────────────────────────────────────────────

export interface CloudInstance {
  id: string
  workspaceId: string
  hostname?: string
  name?: string
  os?: string | null
  arch?: string | null
  kind?: string
  status?: string
  lastSeenAt?: string | null
  [k: string]: unknown
}

const LOOKUP_TTL_MS = 60_000
interface CacheEntry { value: CloudInstance | null; expiresAt: number }
const instanceCache = new Map<string, CacheEntry>()

/** Test-only: clear the lookup cache. */
export function _resetInstanceCache(): void {
  instanceCache.clear()
}

function cacheGet(id: string): CloudInstance | null | undefined {
  const entry = instanceCache.get(id)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    instanceCache.delete(id)
    return undefined
  }
  return entry.value
}

function cacheSet(id: string, value: CloudInstance | null): void {
  instanceCache.set(id, { value, expiresAt: Date.now() + LOOKUP_TTL_MS })
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

/**
 * Headers we forward to cloud. Cookie, host, content-length are deliberately
 * dropped: cookie is a local-only Better Auth credential, host belongs to
 * the upstream, content-length is recomputed by fetch.
 *
 * The allow-list is permissive so streaming (`accept: text/event-stream`)
 * and protocol-handshake headers used by the transparent proxy
 * (`x-remote-control`, `x-remote-protocol-version`, `x-sync-version`,
 * `x-client-version`, `x-chat-session-id`, `x-tunnel-auth-*`) pass through.
 */
const HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'x-remote-control',
  'x-remote-protocol-version',
  'x-sync-version',
  'x-client-version',
  'x-chat-session-id',
  'x-runtime-token',
  'x-tunnel-auth-user-id',
  'x-tunnel-auth-email',
  'x-tunnel-auth-name',
])

const HEADER_PREFIX_ALLOWLIST = ['x-shogo-']

function isAllowedHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (HEADER_ALLOWLIST.has(lower)) return true
  return HEADER_PREFIX_ALLOWLIST.some((p) => lower.startsWith(p))
}

/** Build the upstream Authorization header from `process.env.SHOGO_API_KEY`. */
async function buildAuthHeader(): Promise<Record<string, string>> {
  const key = await getUpstreamCredential()
  if (!key) return {}
  return { Authorization: `Bearer ${key}` }
}

function buildUpstreamUrl(path: string, search: string): string {
  const base = getShogoCloudUrl()
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}${search || ''}`
}

async function fetchUpstream(
  path: string,
  init: RequestInit & { search?: string } = {},
): Promise<Response> {
  const url = buildUpstreamUrl(path, init.search ?? '')
  const auth = await buildAuthHeader()
  const headers = new Headers(init.headers ?? undefined)
  for (const [k, v] of Object.entries(auth)) headers.set(k, v)
  const resp = await fetch(url, { ...init, headers })
  if (resp.status === 401) {
    notifyRejection(`upstream ${path} returned 401`)
  }
  return resp
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * GET cloud's instance list scoped to the cloud workspace the local
 * SHOGO_API_KEY is bound to. Returns `[]` if federation is off, no
 * cloud workspace is linked, or the upstream rejects.
 *
 * The `_localWorkspaceId` argument is accepted for parity with the
 * route handler signature but is intentionally NOT forwarded: cloud
 * uses Better Auth memberships keyed by cloud workspace IDs, which
 * don't match the local DB's IDs. Forwarding the local id would
 * always 403 on the cloud's `member.findFirst` check.
 *
 * Cache is populated for each id so subsequent `lookupCloudInstance`
 * calls are free.
 */
export async function listCloudInstancesForWorkspace(
  _localWorkspaceId: string,
): Promise<CloudInstance[]> {
  if (!(await isFederatedEnabled())) return []

  const cloudWorkspaceId = await getUpstreamWorkspaceId()
  if (!cloudWorkspaceId) return []

  try {
    const resp = await fetchUpstream(
      '/api/instances',
      { method: 'GET', search: `?workspaceId=${encodeURIComponent(cloudWorkspaceId)}` },
    )
    if (!resp.ok) return []
    const body = (await resp.json().catch(() => null)) as { instances?: CloudInstance[] } | null
    const list = body?.instances ?? []
    for (const inst of list) {
      if (inst?.id) cacheSet(inst.id, inst)
    }
    return list
  } catch {
    return []
  }
}

/**
 * Look up a single instance on cloud. Cached for 60s; 401/404 evict the
 * entry immediately so a re-link or a worker reconnect is reflected in
 * the next call.
 */
export async function lookupCloudInstance(id: string): Promise<CloudInstance | null> {
  if (!(await isFederatedEnabled())) return null

  const cached = cacheGet(id)
  if (cached !== undefined) return cached

  try {
    const resp = await fetchUpstream(`/api/instances/${encodeURIComponent(id)}`, { method: 'GET' })
    if (resp.status === 404 || resp.status === 401) {
      cacheSet(id, null)
      return null
    }
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as CloudInstance | null
    cacheSet(id, body)
    return body
  } catch {
    return null
  }
}

/** Invalidate the cache for a single instance — useful when a write
 *  endpoint succeeds and the next read should bypass the TTL. */
export function invalidateCloudInstance(id: string): void {
  instanceCache.delete(id)
}

export interface ForwardOptions {
  /** Override the upstream path. Defaults to `c.req.path`. */
  path?: string
  /** Override the upstream querystring (including leading `?`). Defaults
   *  to whatever the client sent. */
  search?: string
}

/**
 * Forward the current Hono request to the configured cloud upstream.
 * Returns the raw fetch `Response` so callers can either:
 *   - `await resp.text()` / `await resp.json()` for buffered responses, or
 *   - pipe `resp.body` back to the client untouched for SSE/streams.
 *
 * Path/search default to the original request's. Method, body, and the
 * allow-listed subset of headers are forwarded. `Authorization` is set
 * to the local-mode cloud credential; cookie/host are dropped.
 */
export async function forwardToUpstream(
  c: Context,
  opts: ForwardOptions = {},
): Promise<Response> {
  const url = new URL(c.req.url)
  const path = opts.path ?? url.pathname
  const search = opts.search ?? url.search

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'

  const fwdHeaders = new Headers()
  c.req.raw.headers.forEach((value, name) => {
    if (isAllowedHeader(name)) fwdHeaders.set(name, value)
  })

  let body: BodyInit | undefined
  if (hasBody) {
    // Read raw bytes so JSON and binary streams both round-trip; cloud
    // will reparse using `content-type`.
    body = await c.req.raw.arrayBuffer()
  }

  return fetchUpstream(path, {
    method,
    headers: fwdHeaders,
    body,
    search,
  })
}

/**
 * Copy upstream response headers we want to surface back to the client.
 * Strips hop-by-hop headers that would confuse the framework or the
 * browser when re-emitted from the local API.
 */
const RESPONSE_HEADER_DENYLIST = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
])

export function copyResponseHeaders(resp: Response): Record<string, string> {
  const out: Record<string, string> = {}
  resp.headers.forEach((value, name) => {
    if (RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) return
    out[name] = value
  })
  return out
}
