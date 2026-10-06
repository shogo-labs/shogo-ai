// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { FALLBACK_GLOW, glowHex, parseHex } from '../agent-glow'

describe('parseHex', () => {
  test('reads a six digit colour with or without the hash', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 })
    expect(parseHex('00ff00')).toEqual({ r: 0, g: 255, b: 0 })
  })

  test('rejects anything else', () => {
    expect(parseHex('#fff')).toBeNull()
    expect(parseHex('orange')).toBeNull()
    expect(parseHex(null)).toBeNull()
  })
})

describe('glowHex', () => {
  test('a saturated colour glows in itself', () => {
    expect(glowHex('#FB8C00')).toBe('#fb8c00')
  })

  test('white and grey agents glow blue instead of a dull haze', () => {
    expect(glowHex('#ffffff')).toBe(FALLBACK_GLOW)
    expect(glowHex('#808080')).toBe(FALLBACK_GLOW)
    expect(glowHex('#000000')).toBe(FALLBACK_GLOW)
  })

  test('a missing or invalid colour glows blue', () => {
    expect(glowHex(undefined)).toBe(FALLBACK_GLOW)
    expect(glowHex('nope')).toBe(FALLBACK_GLOW)
  })
})
