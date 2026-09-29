// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { getIslandBounds, isNotchedDisplay } from '../island-placement'

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
      x: 2700,
      y: 0,
      width: 360,
      height: 300,
    })
  })
})
