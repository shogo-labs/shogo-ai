// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-region request proxy.
 *
 * Forwards an in-flight request from this region to a sibling ("peer") region's
 * API and streams the response straight back. Used by:
 *   - the admin region console (`/api/admin/regions/:regionId/*`), and
 *   - the home-region write router (proxying a workspace's mutations to the
 *     region that owns it).
 *
 * Both request and response bodies are streamed (no `await text()` buffering) so
 * this works for SSE endpoints like `/api/projects/:id/chat`.
 */

import type { Context } from 'hono'
import { getPeer, HOST_HEADER_FOR_PEERS } from './region'

/**
 * Loop-guard header. The proxy stamps this on every outbound request; the
 * receiving region must treat its presence as "this is already a proxied
 * request, handle it locally and never proxy again" to avoid infinite ping-pong
 * between regions.
 */
export const HOME_REGION_PROXY_HEADER = 'x-shogo-home-region-proxy'

/** Request headers we forward verbatim to the peer (lower-cased). */
const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'cookie',
  'authorization',
  'accept',
  'accept-language',
  'user-agent',
  'x-shogo-api-key',
  'x-api-key',
  'idempotency-key',
]

/**
 * Response headers we must NOT copy back (hop-by-hop / length headers that the
 * runtime recomputes when we re-stream the body).
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

export interface ProxyToPeerOptions {
  /**
   * Path prefix to strip before forwarding (e.g. the admin console mounts peers
   * under `/api/admin/regions/:id` but the peer expects the bare `/api/...`
   * path). The home-region write router leaves this unset so the path is
   * forwarded unchanged.
   */
  stripPrefix?: string
}

/**
 * Returns true when this request was itself produced by `proxyToPeer` (carries
 * the loop-guard header), meaning the current region must handle it locally.
 */
export function isProxiedRequest(c: Context): boolean {
  return c.req.header(HOME_REGION_PROXY_HEADER) === '1'
}

/**
 * Proxy the current request to `regionId` and return the streamed response.
 * Returns a 502 if the region is unknown (no peer configured).
 */
export async function proxyToPeer(
  c: Context,
  regionId: string,
  opts: ProxyToPeerOptions = {},
): Promise<Response> {
  const peer = getPeer(regionId)
  if (!peer) {
    return c.json({ error: `No peer configured for region: ${regionId}` }, 502)
  }

  const originalUrl = new URL(c.req.url)
  let path = originalUrl.pathname
  if (opts.stripPrefix && path.startsWith(opts.stripPrefix)) {
    path = path.slice(opts.stripPrefix.length) || '/'
  }
  const targetUrl = new URL(path, peer.url)
  targetUrl.search = originalUrl.search

  const src = c.req.raw.headers
  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = src.get(name)
    if (v) headers.set(name, v)
  }
  // Forward any custom x-shogo-* headers (region/runtime metadata).
  src.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-shogo-')) headers.set(key, value)
  })
  // Peers share one public hostname; spoof Host/Origin so CORS + Better Auth
  // trusted-origin checks pass on the receiving side.
  headers.set('Host', HOST_HEADER_FOR_PEERS)
  headers.set('Origin', `https://${HOST_HEADER_FOR_PEERS}`)
  headers.set(HOME_REGION_PROXY_HEADER, '1')

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'

  let resp: Response
  try {
    resp = await fetch(targetUrl.toString(), {
      method,
      headers,
      // Stream the request body straight through (duplex required for streams).
      ...(hasBody ? { body: c.req.raw.body, duplex: 'half' } : {}),
      // Peers terminate TLS behind the same cert; tolerate self-signed in-mesh.
      ...(typeof Bun !== 'undefined' ? { tls: { rejectUnauthorized: false } } : {}),
    } as any)
  } catch (err: any) {
    return c.json(
      { error: `Proxy to ${peer.label || regionId} failed: ${err?.message || String(err)}` },
      502,
    )
  }

  const respHeaders = new Headers()
  resp.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value)
  })
  // Preserve any Set-Cookie headers (auth flows) individually.
  const setCookies = (resp.headers as any).getSetCookie?.() as string[] | undefined
  if (setCookies && setCookies.length) {
    respHeaders.delete('set-cookie')
    for (const cookie of setCookies) respHeaders.append('set-cookie', cookie)
  }

  return new Response(resp.body, { status: resp.status, headers: respHeaders })
}

/** Result of a cross-region internal JSON RPC. */
export interface PeerInternalResult<T> {
  status: number
  ok: boolean
  data: T | null
}

/**
 * Make a service-to-service JSON RPC to a peer region's `/api/internal/*`
 * surface. Unlike `proxyToPeer` this is NOT a request pass-through: it POSTs a
 * fresh JSON body authenticated by the shared `SHOGO_INTERNAL_SECRET` (the same
 * token metal/affiliate internal hooks use), so it works across clusters where
 * a K8s ServiceAccount token would not validate. Used by the usage-wallet
 * single-writer path to route a wallet mutation to `workspace.homeRegion`.
 *
 * Throws only when no peer is configured for `regionId`; transport/HTTP errors
 * are surfaced to the caller via `{ ok:false }` / a thrown fetch error so the
 * caller can decide fail-open vs fail-closed.
 */
export async function callPeerInternal<T = unknown>(
  regionId: string,
  path: string,
  body: unknown,
): Promise<PeerInternalResult<T>> {
  const peer = getPeer(regionId)
  if (!peer) throw new Error(`No peer configured for region: ${regionId}`)

  const url = new URL(path, peer.url).toString()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Peers share one public hostname; spoof Host so ingress routes correctly.
    Host: HOST_HEADER_FOR_PEERS,
    // Loop guard: the receiving region must treat this as already-proxied.
    [HOME_REGION_PROXY_HEADER]: '1',
  }
  const secret = process.env.SHOGO_INTERNAL_SECRET
  if (secret) headers['x-shogo-internal-secret'] = secret

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // Peers terminate TLS behind the same cert; tolerate self-signed in-mesh.
    ...(typeof Bun !== 'undefined' ? { tls: { rejectUnauthorized: false } } : {}),
  } as any)

  let data: T | null = null
  try {
    data = (await resp.json()) as T
  } catch {
    data = null
  }
  return { status: resp.status, ok: resp.ok, data }
}
