// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DICTATION_CONFIG,
  isValidAccelerator,
  normalizeDictationConfig,
} from '../dictation-protocol'

describe('isValidAccelerator', () => {
  test('accepts modifier + key combos', () => {
    for (const ok of ['Cmd+Shift+D', 'Ctrl+Alt+Space', 'CommandOrControl+F5', 'Option+/', 'Shift+Cmd+1']) {
      expect(isValidAccelerator(ok)).toBe(true)
    }
  })

  test('rejects bare keys, modifier-only, and junk', () => {
    for (const bad of ['', 'D', 'Cmd', 'Cmd+Shift', 'Cmd+D+E', 'Cmd++D', 'Cmd+Banana', 'Fn', 'x'.repeat(80)]) {
      expect(isValidAccelerator(bad)).toBe(false)
    }
  })
})

describe('normalizeDictationConfig', () => {
  test('defaults to Fn push-to-talk with hands-free off', () => {
    expect(normalizeDictationConfig(undefined)).toEqual({ pushToTalk: 'Fn', handsFree: null })
    expect(normalizeDictationConfig('nope')).toEqual(DEFAULT_DICTATION_CONFIG)
  })

  test('null disables a shortcut, missing keys keep the base', () => {
    expect(normalizeDictationConfig({ pushToTalk: null })).toEqual({ pushToTalk: null, handsFree: null })
    expect(normalizeDictationConfig({ handsFree: 'Cmd+Shift+D' })).toEqual({
      pushToTalk: 'Fn',
      handsFree: 'Cmd+Shift+D',
    })
  })

  test('invalid values fall back; Fn is only valid for push-to-talk', () => {
    expect(normalizeDictationConfig({ pushToTalk: 'garbage' }).pushToTalk).toBe('Fn')
    expect(normalizeDictationConfig({ handsFree: 'Fn' }).handsFree).toBeNull()
    expect(normalizeDictationConfig({ pushToTalk: 42 }).pushToTalk).toBe('Fn')
  })

  test('push-to-talk chord can be customised', () => {
    expect(normalizeDictationConfig({ pushToTalk: 'Ctrl+Space' }).pushToTalk).toBe('Ctrl+Space')
  })

  test('identical combos drop hands-free', () => {
    expect(normalizeDictationConfig({ pushToTalk: 'Ctrl+Space', handsFree: 'ctrl+space' })).toEqual({
      pushToTalk: 'Ctrl+Space',
      handsFree: null,
    })
  })
})
