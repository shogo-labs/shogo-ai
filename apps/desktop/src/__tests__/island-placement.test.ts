// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ISLAND_MIN_CONTENT_HEIGHT,
  getIslandBounds,
  getIslandTopInset,
  isNotchedDisplay,
} from '../island-placement'

const notchedMac = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 945 },
}

const regularDisplay = {
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
}

describe('Shogo island placement', () => {
  test('recognizes a notched macOS display from menu-bar height', () => {
    expect(isNotchedDisplay(notchedMac, 'darwin')).toBe(true)
    expect(isNotchedDisplay(regularDisplay, 'darwin')).toBe(false)
    expect(isNotchedDisplay(notchedMac, 'win32')).toBe(false)
  })

  test('straddles the notch at menu-bar height on a notched Mac', () => {
    expect(getIslandBounds(notchedMac, 'collapsed', 'darwin')).toEqual({
      x: 566,
      y: 0,
      width: 380,
      height: 37,
    })
  })

  test('keeps the standard pill on displays without a notch', () => {
    expect(getIslandBounds(regularDisplay, 'collapsed', 'darwin')).toEqual({
      x: 2775,
      y: 0,
      width: 210,
      height: 36,
    })
  })

  test('uses the work-area top on regular displays', () => {
    expect(getIslandBounds(regularDisplay, 'compose', 'win32')).toEqual({
      x: 2640,
      y: 0,
      width: 480,
      height: 640,
    })
  })

  test('sizes card modes to the reported content height within bounds', () => {
    expect(getIslandBounds(regularDisplay, 'expanded', 'win32', 300.2).height).toBe(301)
    expect(getIslandBounds(regularDisplay, 'expanded', 'win32', 40).height).toBe(ISLAND_MIN_CONTENT_HEIGHT)
    expect(getIslandBounds(regularDisplay, 'expanded', 'win32', 5000).height).toBe(640)
    const shortDisplay = {
      bounds: { x: 0, y: 0, width: 1280, height: 600 },
      workArea: { x: 0, y: 24, width: 1280, height: 576 },
    }
    expect(getIslandBounds(shortDisplay, 'compose', 'win32', 5000).height).toBe(Math.floor(576 * 0.85))
  })

  test('ignores content height outside card modes', () => {
    expect(getIslandBounds(regularDisplay, 'collapsed', 'darwin', 500)).toEqual(
      getIslandBounds(regularDisplay, 'collapsed', 'darwin'),
    )
  })

  test('reports the menu-bar inset only on notched displays', () => {
    expect(getIslandTopInset(notchedMac, 'darwin')).toBe(37)
    expect(getIslandTopInset(notchedMac, 'win32')).toBe(0)
    expect(getIslandTopInset(regularDisplay, 'darwin')).toBe(0)
  })
})
