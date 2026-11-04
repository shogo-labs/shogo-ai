// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Header policy for the public preview proxies.
 *
 * The root preview serves a static build and can drop cookies and auth
 * headers. A per-port preview serves the project's own dev server, which
 * authenticates the browser (Authorization, apikey, Cookie) and sets its
 * own cookies. Those must pass through. The runtime's internal
 * `x-runtime-token` must not, in either direction.
 */

/**
 * Header the edge Workers (preview-router, subdomain-router) add to every
 * request they forward to the API, carrying `SHOGO_EDGE_PROXY_SECRET`. Stripped
 * from any client-supplied value at the edge, so its presence is proof the
 * request came through the Worker for that user-app host. Also stripped before
 * anything is forwarded to a user's app.
 */
export const EDGE_PROXY_HEADER = 'x-shogo-edge-auth'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
])

/** Copy the visitor's headers onto the upstream request, minus hop-by-hop, the runtime token and the edge-proxy secret. */
export function forwardClientHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  incoming.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.has(k) || k === 'x-runtime-token' || k === EDGE_PROXY_HEADER) return
    headers.append(key, value)
  })
  return headers
}

export function filterUpstreamResponseHeaders(
  upstream: Headers,
  opts: { passSetCookie: boolean },
): Headers {
  const out = new Headers()
  const setCookies: string[] = []
  upstream.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'transfer-encoding' || k === 'connection') return
    if (k === 'x-frame-options' || k === 'content-security-policy') return
    // A guest that echoes request headers must not leak the runtime token
    // (or an Authorization header it reflected) to the public visitor.
    if (k === 'x-runtime-token' || k === 'authorization') return
    if (k === 'set-cookie') {
      if (opts.passSetCookie) setCookies.push(value)
      return
    }
    out.append(key, value)
  })
  for (const cookie of setCookies) out.append('set-cookie', cookie)
  out.set('access-control-allow-origin', '*')
  return out
}

/**
 * `Content-Security-Policy` for a user-app proxy response from a caller not
 * trusted with the visitor's session (a direct call on a Studio/API host; local
 * desktop mode and a self-hosted API on their own domain are trusted). The
 * sandbox gives the document an opaque origin: the app's scripts run, but never
 * as the page that framed them and never with that page's cookies.
 */
export const USER_APP_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups'

/** Headers forwarded to a metal published app's own `/api/*` server. */
export function publishedProxyRequestHeaders(incoming: Headers, opts: { trustVisitor: boolean }): Headers {
  const headers = new Headers()
  const names = [
    'content-type', 'accept', 'accept-encoding', 'accept-language',
    'user-agent', 'range', 'if-none-match', 'if-modified-since', 'cache-control',
    'x-forwarded-for', 'x-forwarded-host',
    // The app answers CORS itself (isPublishedApiProxyPath skips the API's).
    'origin', 'access-control-request-method', 'access-control-request-headers',
  ]
  // The visitor's session stays with the edge: an untrusted caller must not hand
  // its Studio/API cookies or bearer token to the app.
  if (opts.trustVisitor) names.push('cookie', 'authorization')
  for (const name of names) {
    const value = incoming.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** Headers returned from a metal published app's own `/api/*` server. */
export function publishedProxyResponseHeaders(upstream: Headers, opts: { trustVisitor: boolean }): Headers {
  const out = new Headers()
  upstream.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'transfer-encoding' || k === 'connection') return
    // A published app may set its own session cookies — but only across the edge,
    // where the browser is on the app's own host. An untrusted caller is on a
    // Studio/API host and must not receive them.
    if (k === 'set-cookie' && !opts.trustVisitor) return
    out.set(key, value)
  })
  if (!opts.trustVisitor) out.set('content-security-policy', USER_APP_SANDBOX_CSP)
  return out
}
