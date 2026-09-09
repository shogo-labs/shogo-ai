// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { Platform } from 'react-native'
import { nativeActivePill } from '../native-active-shadow'

describe('nativeActivePill', () => {
  test('returns no class or style when inactive', () => {
    expect(nativeActivePill(false)).toEqual({ className: '', style: undefined })
  })

  test('does not emit a NativeWind shadow class on native', () => {
    const pill = nativeActivePill(true)
    if (Platform.OS === 'web') {
      expect(pill.className).toBe('bg-background shadow-sm')
      expect(pill.style).toBeUndefined()
    } else {
      expect(pill.className).toBe('bg-background')
      expect(pill.className).not.toMatch(/shadow-/)
      expect(pill.style).toBeTruthy()
    }
  })

  test('keeps a custom active background without toggling shadow-* on native', () => {
    const pill = nativeActivePill(true, { backgroundClass: 'bg-primary' })
    if (Platform.OS === 'web') {
      expect(pill.className).toBe('bg-primary shadow-sm')
    } else {
      expect(pill.className).toBe('bg-primary')
    }
  })

  test('can omit the web shadow class for pills that never had one', () => {
    const pill = nativeActivePill(true, { webShadow: false })
    expect(pill.className).toBe('bg-background')
    if (Platform.OS === 'web') {
      expect(pill.style).toBeUndefined()
    } else {
      expect(pill.style).toBeTruthy()
    }
  })
})
