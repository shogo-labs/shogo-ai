// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { PREVIEW_MAX_EDGE, previewSize } from '../chat-image-preview'

describe('previewSize', () => {
  test('scales a landscape photo down to the max long edge', () => {
    expect(previewSize(4000, 3000)).toEqual({ width: 640, height: 480 })
  })

  test('scales a portrait photo by its height', () => {
    expect(previewSize(3000, 4000)).toEqual({ width: 480, height: 640 })
  })

  test('never upscales an image that is already small', () => {
    expect(previewSize(320, 200)).toEqual({ width: 320, height: 200 })
  })

  test('leaves an image exactly at the max edge alone', () => {
    expect(previewSize(PREVIEW_MAX_EDGE, 200)).toEqual({ width: 640, height: 200 })
  })

  test('keeps a panorama whole rather than clamping its aspect', () => {
    const size = previewSize(6000, 1000)
    expect(size).toEqual({ width: 640, height: 107 })
  })

  test('never rounds a dimension down to zero', () => {
    const size = previewSize(20000, 1)
    expect(size?.height).toBe(1)
  })

  test('returns null without a usable size', () => {
    expect(previewSize(undefined, 100)).toBeNull()
    expect(previewSize(100, undefined)).toBeNull()
    expect(previewSize(0, 0)).toBeNull()
    expect(previewSize(-10, 10)).toBeNull()
    expect(previewSize(Number.NaN, 10)).toBeNull()
  })
})
