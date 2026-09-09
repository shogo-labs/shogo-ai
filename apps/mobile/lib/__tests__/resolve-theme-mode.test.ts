// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { resolveThemeMode } from '../resolve-theme-mode'

describe('resolveThemeMode', () => {
  test('honors an explicit light or dark preference over the OS scheme', () => {
    expect(resolveThemeMode('light', 'dark')).toBe('light')
    expect(resolveThemeMode('dark', 'light')).toBe('dark')
  })

  test('follows the OS scheme in system mode', () => {
    expect(resolveThemeMode('system', 'dark')).toBe('dark')
    expect(resolveThemeMode('system', 'light')).toBe('light')
    expect(resolveThemeMode('system', null)).toBe('light')
    expect(resolveThemeMode('system', undefined)).toBe('light')
  })
})
