// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect } from 'bun:test'

import { formatModKey, isMacKeyboardPlatform } from '../keyboard-shortcuts'

describe('isMacKeyboardPlatform', () => {
  test('detects macOS and iOS platform strings', () => {
    expect(isMacKeyboardPlatform('MacIntel')).toBe(true)
    expect(isMacKeyboardPlatform('iPhone')).toBe(true)
    expect(isMacKeyboardPlatform('iPad')).toBe(true)
  })

  test('treats Windows and Linux as non-Mac', () => {
    expect(isMacKeyboardPlatform('Win32')).toBe(false)
    expect(isMacKeyboardPlatform('Linux x86_64')).toBe(false)
  })
})

describe('formatModKey', () => {
  test('uses ⌘ on Mac platforms', () => {
    expect(formatModKey('k', 'MacIntel')).toBe('⌘K')
  })

  test('uses Ctrl+ on Windows and Linux', () => {
    expect(formatModKey('k', 'Win32')).toBe('Ctrl+K')
    expect(formatModKey('k', 'Linux x86_64')).toBe('Ctrl+K')
  })

  test('uppercases single-character keys', () => {
    expect(formatModKey('p', 'Win32')).toBe('Ctrl+P')
  })
})
