// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Platform } from 'react-native'
import { nativeActivePill } from '../native-active-shadow'

const CONDITIONAL_SHADOW_CLASS =
  /(?:\?|&&)\s*['"`][^'"`]*\bshadow-(?:sm|md|lg|xl|2xl|hard-\d+)/

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walkSourceFiles(path, acc)
      continue
    }
    if (/\.(tsx|ts)$/.test(name) && !name.includes('.test.')) acc.push(path)
  }
  return acc
}

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

describe('conditional NativeWind shadow classes', () => {
  test('are not toggled on Pressable/View classNames anywhere in the mobile app', () => {
    const mobileRoot = join(import.meta.dir, '../..')
    const hits: string[] = []
    for (const root of ['app', 'components', 'lib']) {
      for (const file of walkSourceFiles(join(mobileRoot, root))) {
        if (file.endsWith('native-active-shadow.ts')) continue
        const source = readFileSync(file, 'utf8')
        if (CONDITIONAL_SHADOW_CLASS.test(source)) {
          hits.push(file.slice(mobileRoot.length + 1))
        }
      }
    }
    expect(hits).toEqual([])
  })
})
