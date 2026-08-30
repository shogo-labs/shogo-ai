// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cache-Control for files served out of `dist/`.
 *
 * Hashed bundler output (Expo `entry-<32hex>.js`, Vite `index-Ab12cd34.js`)
 * is safe to pin forever: a rebuild emits a new name and `index.html` is
 * already `no-cache`. Unhashed files — `captureRelay.worklet.js`, copied
 * `public/` assets, `.wasm` without a hash — must revalidate, or a canvas
 * refresh keeps serving yesterday's worklet for a year.
 */
export function isContentHashedFilename(fileName: string): boolean {
  const base = fileName.split('/').pop() || fileName
  // Bundlers put the hash in the last `-`/`_` segment before the extension.
  // `captureRelay.worklet.js` uses a short extra extension and must not match.
  return /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
}

export function staticAssetCacheControl(fileName: string): string {
  return isContentHashedFilename(fileName)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
}
