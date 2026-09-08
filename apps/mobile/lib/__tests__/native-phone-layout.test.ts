// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { nativeContentWidth, nativePhoneCanvas, nativePhoneFillStyle, nativeSettingsPaneFill, nativeSettingsPaneStyle, nativeSkillsActionWidths, nativeEqualChipWidths, nativeGridChipWidth, nativeTwoColumnCardWidth, NATIVE_PHONE_CANVAS } from '../native-phone-layout'

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

describe('nativeSkillsActionWidths', () => {
  test('library + gap + refresh fill the picker content width', () => {
    const { row, library, refresh } = nativeSkillsActionWidths(402)
    expect(row).toBe(378)
    expect(refresh).toBe(44)
    expect(library + 8 + refresh).toBe(row)
  })
})

describe('nativeEqualChipWidths', () => {
  test('splits the picker row into equal chips with gaps', () => {
    const { row, chip, lastChip } = nativeEqualChipWidths(402, 4, 8)
    expect(row).toBe(378)
    expect(chip * 3 + lastChip + 8 * 3).toBe(row)
  })
})

describe('nativeSettingsPaneFill', () => {
  test('allows nested ScrollViews to shrink instead of growing with content', () => {
    expect(nativeSettingsPaneFill).toEqual({
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    })
  })
})

describe('nativeSettingsPaneStyle', () => {
  test('pins a pixel width so Yoga cannot shrink-wrap the pane', () => {
    expect(nativeSettingsPaneStyle(402)).toEqual({
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      width: 402,
      maxWidth: 402,
      alignSelf: 'stretch',
    })
  })
})

describe('nativeTwoColumnCardWidth', () => {
  test('splits the padded pane into two equal cards with a gap', () => {
    expect(nativeTwoColumnCardWidth(402)).toBe(179)
  })
})

describe('nativeGridChipWidth', () => {
  test('splits a row into equal columns', () => {
    expect(nativeGridChipWidth(320, 2, 0)).toBe(160)
    expect(nativeGridChipWidth(320, 4, 0)).toBe(80)
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

describe('nativePhoneCanvas', () => {
  test('matches the ChatGPT light and dark canvases', () => {
    expect(nativePhoneCanvas(true)).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativePhoneCanvas(false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(NATIVE_PHONE_CANVAS).toEqual({ dark: '#000000', light: '#ffffff' })
  })
})
