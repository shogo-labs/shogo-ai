// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  isNativeComposerKeyboardOpen,
  nativeComposerKeyboardPad,
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
