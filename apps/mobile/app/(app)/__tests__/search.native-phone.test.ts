// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../search.tsx'), 'utf8')

describe('search native dock bleed', () => {
  test('floats the search dock over a canvas fade so rows dissolve instead of clipping', () => {
    expect(source).toContain('testID="search-native-dock"')
    expect(source).toContain('testID="search-native-results"')
    expect(source).toContain('LinearGradient')
    expect(source).toContain('NATIVE_PHONE_DOCK_FADE')
    expect(source).toContain('nativePhoneDockFadeColors')
    expect(source).toContain('marginTop: -(SEARCH_DOCK_PAD_TOP + SEARCH_DOCK_ROW)')
    expect(source).toContain('const pageBg = nativePhoneCanvas(isDark)')
    expect(source).toContain('nativePhoneDockGlassStyle')
    expect(source).toContain('backgroundColor: pageBg')
    expect(source).not.toContain('bg-muted px-4')
  })
})
