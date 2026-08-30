// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  isContentHashedFilename,
  staticAssetCacheControl,
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
