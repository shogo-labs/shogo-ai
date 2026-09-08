// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { nativeContentWidth, nativePhoneFillStyle } from '../native-phone-layout'

describe('nativeContentWidth', () => {
  test('subtracts the default section inset', () => {
    expect(nativeContentWidth(402)).toBe(370)
  })

  test('subtracts an explicit padding', () => {
    expect(nativeContentWidth(402, 24)).toBe(378)
  })

  test('does not go negative', () => {
    expect(nativeContentWidth(10, 32)).toBe(0)
  })
})

describe('nativePhoneFillStyle', () => {
  test('uses a pixel width instead of a percentage', () => {
    expect(nativePhoneFillStyle(402)).toEqual({
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: 402,
      maxWidth: 402,
    })
  })
})
