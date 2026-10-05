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

/** Copy the visitor's headers onto the upstream request, minus hop-by-hop and the runtime token. */
export function forwardClientHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  incoming.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.has(k) || k === 'x-runtime-token') return
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
