// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Header skip-lists for the api's reverse-proxy code paths.
 *
 * Three flavours of "drop these on the floor", consolidated here because
 * they were copy-pasted (with subtle drift) across `tools-proxy.ts`,
 * `marketplace.ts`, and `integrations.ts`. The duplication had already
 * caused at least one production bug (response decompression breaking
 * because `content-encoding`/`content-length` weren't filtered when
 * passing through transparent gzip from upstreams).
 *
 * Naming convention:
 *   - HOP_BY_HOP_HEADERS: the RFC 7230 §6.1 hop-by-hop set. Always
 *     dropped — these are connection-scoped and lying about them to a
 *     downstream is a category error.
 *   - REQUEST_FORWARD_SKIP_HEADERS: hop-by-hop + `cookie`. Used when we
 *     forward a *request* to an upstream we control via API key. The
 *     local browser's cookies are meaningless against the upstream and
 *     leak SameSite cookies cross-origin.
 *   - RESPONSE_FORWARD_SKIP_HEADERS: REQUEST_FORWARD_SKIP_HEADERS +
 *     `content-encoding` + `content-length`. We hand the response body
 *     to Hono, which re-frames it; preserving the upstream's
 *     content-length / content-encoding causes the browser to try to
 *     decompress an already-decompressed body, or trust a length that
 *     no longer matches.
 *
 * Use `shouldSkipForwardedHeader(name)` /
 * `shouldSkipResponseHeader(name)` — both are case-insensitive.
 */

/** RFC 7230 §6.1 hop-by-hop headers. Always strip when forwarding. */
const HOP_BY_HOP_HEADERS = [
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
] as const

/**
 * Headers stripped from outgoing request copies when forwarding to a
 * trusted upstream we authenticate against via API key. We add `cookie`
 * because the local browser's cookies were issued by us, not by the
 * upstream, and forwarding them creates a confused-deputy risk plus
 * leaks SameSite cookies cross-origin.
 */
export const REQUEST_FORWARD_SKIP_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP_HEADERS,
  'cookie',
])

/**
 * Headers stripped from upstream responses before re-emitting to the
 * client. Adds `content-encoding` and `content-length` to the request
 * skip-list because Hono re-frames the body — preserving the upstream's
 * length/encoding tells the browser to try to decompress an already-
 * decompressed body, or to trust a length that no longer matches.
 */
export const RESPONSE_FORWARD_SKIP_HEADERS: ReadonlySet<string> = new Set([
  ...REQUEST_FORWARD_SKIP_HEADERS,
  'content-encoding',
  'content-length',
])

/** Case-insensitive lookup for the request skip-list. */
export function shouldSkipForwardedHeader(name: string): boolean {
  return REQUEST_FORWARD_SKIP_HEADERS.has(name.toLowerCase())
}

/** Case-insensitive lookup for the response skip-list. */
export function shouldSkipResponseHeader(name: string): boolean {
  return RESPONSE_FORWARD_SKIP_HEADERS.has(name.toLowerCase())
}
