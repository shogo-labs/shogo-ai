// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  isContentHashedFilename,
  staticAssetCacheControl,
  shouldServeSpaFallback,
} from '../static-asset-cache'

describe('isContentHashedFilename', () => {
  test('matches Expo export hashed JS/CSS', () => {
    expect(isContentHashedFilename('entry-2a1fc96ca48b8c3d7e9f55403d900c70.js')).toBe(true)
    expect(isContentHashedFilename('_expo/static/css/web-c0f8c76f038ca38fe232d90191304460.css')).toBe(true)
  })

  test('matches Vite hashed chunks', () => {
    expect(isContentHashedFilename('index-B2xY9abc.js')).toBe(true)
    expect(isContentHashedFilename('index-a1b2c3d4.js')).toBe(true)
  })

  test('rejects unhashed public/ worklets and wasm', () => {
    expect(isContentHashedFilename('captureRelay.worklet.js')).toBe(false)
    expect(isContentHashedFilename('pyin_f0_bg.wasm')).toBe(false)
    expect(isContentHashedFilename('favicon.ico')).toBe(false)
  })
})

describe('staticAssetCacheControl', () => {
  test('pins hashed assets and revalidates the rest', () => {
    expect(staticAssetCacheControl('entry-2a1fc96ca48b8c3d7e9f55403d900c70.js')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(staticAssetCacheControl('captureRelay.worklet.js')).toBe('no-cache')
  })
})

// Repro for the "blank white page after rebuild" pain point (production
// AI Insights digest, 2026-09-18/20/09-21 and 27 of the last 31 days):
// a browser tab holding a stale `index.html` requests an old hashed bundle
// (e.g. `/assets/index-OLDHASH.js`) that an atomic dist swap already
// removed. Before this function existed, `serveDistResponse` unconditionally
// fell back to `index.html` (200, text/html) for ANY miss, so the browser
// tried to parse an HTML document as a JS module and the page went blank
// with no error surfaced anywhere. `shouldServeSpaFallback` draws the line:
// recognized static-asset extensions must 404 on a miss (so the browser's
// `error` event fires and canvas-bridge.js can recover); only extension-less
// / `.html` paths — real SPA routes — still get the `index.html` fallback.
describe('shouldServeSpaFallback', () => {
  test('does NOT fall back for missing hashed JS/CSS bundles (the bug)', () => {
    expect(shouldServeSpaFallback('/assets/index-OLDHASH123.js')).toBe(false)
    expect(shouldServeSpaFallback('/assets/index-abcd1234.css')).toBe(false)
    expect(shouldServeSpaFallback('assets/main-9f8e7d6c.mjs')).toBe(false)
  })

  test('does NOT fall back for other recognized static-asset extensions', () => {
    for (const path of [
      '/favicon.ico', '/manifest.webmanifest', '/logo.png', '/photo.jpg',
      '/photo.jpeg', '/anim.gif', '/icon.svg', '/pic.webp', '/font.woff',
      '/font.woff2', '/font.ttf', '/font.eot', '/data.json', '/index.js.map',
      '/robots.txt', '/sitemap.xml',
    ]) {
      expect(shouldServeSpaFallback(path)).toBe(false)
    }
  })

  test('DOES fall back for extension-less app routes (client-side routing)', () => {
    expect(shouldServeSpaFallback('/dashboard')).toBe(true)
    expect(shouldServeSpaFallback('/projects/123/settings')).toBe(true)
    expect(shouldServeSpaFallback('/')).toBe(true)
  })

  test('DOES fall back for .html paths', () => {
    expect(shouldServeSpaFallback('/index.html')).toBe(true)
    expect(shouldServeSpaFallback('/nested/page.html')).toBe(true)
  })

  test('a dotfile with no extension (e.g. a route segment like "v1.2") still falls back', () => {
    // Dot appears but not as a recognized extension boundary at the end —
    // guard against treating every dot as "this is a static asset".
    expect(shouldServeSpaFallback('/release-v1.2')).toBe(true)
  })
})
