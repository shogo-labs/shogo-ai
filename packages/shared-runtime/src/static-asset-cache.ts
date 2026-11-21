// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cache policy shared by preview and publish servers. Only filenames with a
 * content hash can safely be immutable because user projects commonly keep
 * the same name for favicons and files under public/.
 */
export function isContentHashedFilename(fileName: string): boolean {
  const base = fileName.split('/').pop() || fileName
  return /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
}

export function staticAssetCacheControl(fileName: string): string {
  return isContentHashedFilename(fileName)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
}

/**
 * The one policy an object may carry when several URLs are served from the same
 * bytes (SHO-485).
 *
 * An object store serves a stored object's own `Cache-Control` — the runtime
 * cannot vary it per response on the length-known body it hands `Bun.serve` —
 * so a `public/` file and a Vite-hashed copy of the same content share a single
 * policy. `immutable` is only safe when EVERY referencing path carries a content
 * hash: otherwise a stable URL like `/About-Us.png` would be cached for a year
 * and keep serving the old logo after a republish.
 */
export function sharedStaticAssetCacheControl(fileNames: readonly string[]): string {
  return fileNames.every((name) => isContentHashedFilename(name))
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
}

/**
 * Extensions that always identify a static-asset request, never an SPA
 * client-side route. Keep in sync with agent-runtime's `STATIC_MIME` map
 * (`dist-response.ts`) — this list intentionally excludes `.html` and
 * extension-less paths, which are the two shapes that should still receive the
 * SPA `index.html` fallback.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.map', '.txt', '.xml',
  '.webmanifest',
])

/**
 * Whether a request for a path missing from `dist/` should fall back to
 * `index.html` (SPA client-side routing) or return a real 404.
 *
 * Historically the SPA fallback applied to every miss, including requests
 * for hashed JS/CSS bundles (e.g. `/assets/index-OLDHASH.js`). When a
 * rebuild atomically swaps in a new `dist/` with new content hashes, a
 * browser tab that still has the previous `index.html` cached keeps
 * requesting the old (now-deleted) hashed filename — and got back a 200
 * HTML document instead of a 404, which the browser can't parse as a JS
 * module. That is the "blank white page after rebuild" production pain
 * point. Recognized static-asset extensions must 404 on a miss so the
 * browser's `error` event fires (letting canvas-bridge.js's stale-asset
 * recovery kick in); only extension-less paths and `.html` — real app
 * routes — still get the SPA fallback.
 */
export function shouldServeSpaFallback(requestPath: string): boolean {
  const base = requestPath.split('/').pop() || requestPath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return true
  const ext = base.slice(dot).toLowerCase()
  if (ext === '.html') return true
  return !STATIC_ASSET_EXTENSIONS.has(ext)
}
