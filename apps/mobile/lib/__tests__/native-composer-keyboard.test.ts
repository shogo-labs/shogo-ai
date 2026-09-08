// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  isNativeComposerKeyboardOpen,
  nativeComposerDockBottomPad,
  nativeComposerKeyboardDuration,
  nativeComposerKeyboardOpenFromSource,
  nativeComposerKeyboardOverlap,
  nativeComposerKeyboardPad,
  nativeComposerShouldIgnoreClosedFrame,
  NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION,
  NATIVE_COMPOSER_KEYBOARD_GAP,
  NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP,
} from '../native-composer-keyboard'

describe('nativeComposerKeyboardPad', () => {
  test('uses the larger of keyboard height and screenY overlap, plus a gap', () => {
    expect(nativeComposerKeyboardPad(undefined, 874)).toBe(NATIVE_COMPOSER_KEYBOARD_GAP)
    expect(nativeComposerKeyboardPad({ height: 336, screenY: 538 }, 874)).toBe(336 + NATIVE_COMPOSER_KEYBOARD_GAP)
    expect(nativeComposerKeyboardPad({ height: 300, screenY: 520 }, 874)).toBe(354 + NATIVE_COMPOSER_KEYBOARD_GAP)
    expect(nativeComposerKeyboardPad({ height: 0, screenY: 874 }, 874)).toBe(NATIVE_COMPOSER_KEYBOARD_GAP)
  })

  test('treats pads within the rest inset plus slop as closed', () => {
    const restPad = 34
    expect(isNativeComposerKeyboardOpen(restPad, restPad)).toBe(false)
    expect(isNativeComposerKeyboardOpen(restPad + NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP, restPad)).toBe(false)
    expect(isNativeComposerKeyboardOpen(restPad + NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP + 1, restPad)).toBe(true)
  })
})

describe('nativeComposerKeyboardOverlap', () => {
  test('returns 0 when the keyboard is closed', () => {
    expect(nativeComposerKeyboardOverlap(undefined, 874)).toBe(0)
    expect(nativeComposerKeyboardOverlap({ height: 0, screenY: 874 }, 874)).toBe(0)
  })
})

describe('nativeComposerKeyboardDuration', () => {
  test('treats missing and second-scale iOS values as milliseconds', () => {
    expect(nativeComposerKeyboardDuration(undefined)).toBe(NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION)
    expect(nativeComposerKeyboardDuration(0)).toBe(NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION)
    expect(nativeComposerKeyboardDuration(0.25)).toBe(NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION)
    expect(nativeComposerKeyboardDuration(250)).toBe(NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION)
  })
})

describe('nativeComposerShouldIgnoreClosedFrame', () => {
  test('ignores zero-height changeFrame events so the dock does not snap back', () => {
    expect(nativeComposerShouldIgnoreClosedFrame(0, 34, 'change')).toBe(true)
    expect(nativeComposerShouldIgnoreClosedFrame(12, 34, 'change')).toBe(true)
    expect(nativeComposerShouldIgnoreClosedFrame(336, 34, 'change')).toBe(false)
    expect(nativeComposerShouldIgnoreClosedFrame(0, 34, 'hide')).toBe(false)
    expect(nativeComposerShouldIgnoreClosedFrame(0, 34, 'show')).toBe(false)
  })
})

describe('nativeComposerKeyboardOpenFromSource', () => {
  test('ignores closed change-frame events and maps show/hide/open overlap', () => {
    expect(nativeComposerKeyboardOpenFromSource('change', 0, 34)).toBe(null)
    expect(nativeComposerKeyboardOpenFromSource('hide', 0, 34)).toBe(false)
    expect(nativeComposerKeyboardOpenFromSource('show', 0, 34)).toBe(true)
    expect(nativeComposerKeyboardOpenFromSource('change', 336, 34)).toBe(true)
  })
})

describe('nativeComposerDockBottomPad', () => {
  test('is flush when iOS KeyboardAvoidingView is lifting, overlap otherwise', () => {
    expect(nativeComposerDockBottomPad({
      keyboardOpen: false,
      overlap: 336,
      restPad: 34,
      iosKeyboardAvoiding: true,
    })).toBe(34)
    expect(nativeComposerDockBottomPad({
      keyboardOpen: true,
      overlap: 336,
      restPad: 34,
      iosKeyboardAvoiding: true,
    })).toBe(0)
    expect(nativeComposerDockBottomPad({
      keyboardOpen: true,
      overlap: 336,
      restPad: 34,
      iosKeyboardAvoiding: false,
    })).toBe(336)
  })
})
