// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `PREVIEW_BASE_PATH` — serve the built app under a path prefix.
 *
 * Host-per-session routing (one hostname per runtime) needs nothing from us.
 * Path-prefix routing (`https://partner.example/s/abc123/`) does, because the
 * generated app calls **absolute** `/api/...` (the SDK generators hardcode
 * `API_BASE = '/api'`), and under a stripped prefix those calls leave the
 * session's path and hit the partner's root.
 *
 * Two halves, both driven by the same env var:
 *
 * 1. {@link injectPreviewBasePath} rewrites `index.html` so same-origin
 *    `/api/...` in `fetch`, `XMLHttpRequest` and `EventSource` becomes
 *    `${PREVIEW_BASE_PATH}/api/...`, and adds a `<base href>` when the document
 *    has none. It runs before any app script, so no template change is needed
 *    and agent-written `fetch('/api/…')` keeps working.
 * 2. {@link stripPreviewBasePath} accepts requests that still carry the prefix,
 *    so the runtime works whether or not the ingress strips it.
 *
 * Unset means no change at all.
 */

/** Normalized prefix (`/s/abc123`), or `null` when the feature is off. */
export function previewBasePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PREVIEW_BASE_PATH?.trim()
  if (!raw) return null
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed || null
}

/**
 * Remove `base` from the front of `pathname`. Returns `null` when the path does
 * not carry the prefix (the ingress already stripped it, or this is a request
 * for something else entirely).
 */
export function stripPreviewBasePath(pathname: string, base: string | null): string | null {
  if (!base) return null
  if (pathname === base) return '/'
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  return null
}

const MARKER = 'data-shogo-preview-base'

/**
 * The inline shim. Kept as a template so the prefix is the only thing that
 * varies; it is deliberately ES5 and dependency-free because it runs before
 * the app's own bundle.
 */
function basePathScript(base: string): string {
  return `<script ${MARKER}="${base}">(function(){var B=${JSON.stringify(base)};` +
    `function fix(u){if(typeof u!=="string")return u;` +
    `if(u!=="/api"&&u.indexOf("/api/")!==0&&u.indexOf("/api?")!==0)return u;return B+u}` +
    `var f=window.fetch;if(f){window.fetch=function(i,o){` +
    `if(typeof i==="string"){i=fix(i)}else if(i&&typeof i.url==="string"){var u=fix(i.url);if(u!==i.url){i=new Request(u,i)}}` +
    `return f.call(this,i,o)}}` +
    `var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){` +
    `var a=[].slice.call(arguments);a[1]=fix(u);return xo.apply(this,a)};` +
    `if(window.EventSource){var E=window.EventSource;var W=function(u,c){return new E(fix(u),c)};` +
    `W.prototype=E.prototype;window.EventSource=W}})();</script>`
}

/**
 * Inject the base-path shim (and a `<base href>` when the document has none)
 * into an HTML document. Idempotent, and a no-op when the prefix is unset.
 */
export function injectPreviewBasePath(html: string, base: string | null): string {
  if (!base) return html
  if (html.indexOf(MARKER) !== -1) return html

  const lower = html.toLowerCase()
  const headOpen = lower.indexOf('<head')
  const headClose = headOpen === -1 ? -1 : lower.indexOf('>', headOpen)
  const hasBase = /<base[\s>]/i.test(html)

  const injection = `${hasBase ? '' : `<base href="${base}/">`}${basePathScript(base)}`

  if (headClose !== -1) {
    return html.slice(0, headClose + 1) + injection + html.slice(headClose + 1)
  }
  // No <head> (a hand-written fragment): the shim still has to run first.
  return injection + html
}
