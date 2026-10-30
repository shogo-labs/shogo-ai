// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { composerAutofocusesOnOpen } from '../composer-autofocus'

describe('composerAutofocusesOnOpen', () => {
  test('takes the caret when a conversation opens on the web', () => {
    expect(composerAutofocusesOnOpen({ platform: 'web', canPost: true })).toBe(true)
  })

  test('leaves the keyboard alone on a phone, where opening a channel means reading', () => {
    expect(composerAutofocusesOnOpen({ platform: 'ios', canPost: true })).toBe(false)
    expect(composerAutofocusesOnOpen({ platform: 'android', canPost: true })).toBe(false)
  })

  test('does not focus a box that cannot be typed into', () => {
    expect(composerAutofocusesOnOpen({ platform: 'web', canPost: false })).toBe(false)
  })
})
