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
  chatComposerDockStyle,
  CHAT_TRANSCRIPT_MAX_WIDTH,
  NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION,
  NATIVE_COMPOSER_KEYBOARD_GAP,
  NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP,
} from '../native-composer-keyboard'
import { WEB_WIDE_MIN_WIDTH } from '../native-phone-layout'

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

describe('CHAT_TRANSCRIPT_MAX_WIDTH', () => {
  test('uses the named web-wide breakpoint instead of a second magic 768', () => {
    expect(CHAT_TRANSCRIPT_MAX_WIDTH).toBe(WEB_WIDE_MIN_WIDTH)
  })
})

describe('chatComposerDockStyle', () => {
  test('puts the keyboard pad on paddingBottom so Animated.View can lift the pill', () => {
    const pad = { __animated: true }
    expect(chatComposerDockStyle({
      measuredWidth: 390,
      keyboardPad: pad,
    })).toEqual([
      { width: 390 },
      { paddingBottom: pad },
    ])
  })

  test('matches the transcript max-w-3xl column when width is not measured', () => {
    expect(chatComposerDockStyle({})).toEqual([
      { width: '100%', maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH },
    ])
  })

  test('keeps web overflow visible so dock cards can float above the pill', () => {
    expect(chatComposerDockStyle({
      keyboardPad: 12,
      webOverflowVisible: true,
    })).toEqual([
      { width: '100%', maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH },
      { paddingBottom: 12, overflow: 'visible' },
    ])
  })
})

describe('nativeComposerDockBottomPad', () => {
  test('keeps a gap above the keyboard so the pill stays oval', () => {
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
    })).toBe(NATIVE_COMPOSER_KEYBOARD_GAP)
    expect(nativeComposerDockBottomPad({
      keyboardOpen: true,
      overlap: 336,
      restPad: 34,
      iosKeyboardAvoiding: false,
    })).toBe(336 + NATIVE_COMPOSER_KEYBOARD_GAP)
  })
})
