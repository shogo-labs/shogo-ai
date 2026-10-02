// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Guards patches/react-native-css-interop@0.2.2.patch. React Native >= 0.82
// caches whatever `Appearance.setColorScheme` receives, so css-interop's
// old `setColorScheme(null)` for the "system" theme left
// `Appearance.getColorScheme()` null and the app stuck in light mode.

import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const interopDir = require
  .resolve('react-native-css-interop/package.json')
  .replace(/package\.json$/, '')
const observables = require(`${interopDir}dist/runtime/native/appearance-observables.js`)
const { INTERNAL_RESET } = require(`${interopDir}dist/shared.js`)

function fakeAppearance(system: 'light' | 'dark') {
  let override: 'light' | 'dark' | null = null
  const calls: unknown[] = []
  return {
    calls,
    getColorScheme: () => override ?? system,
    setColorScheme: (value: unknown) => {
      calls.push(value)
      // Mirrors React Native 0.86: only 'light'/'dark' pin the scheme.
      override = value === 'light' || value === 'dark' ? value : null
    },
    addChangeListener: () => ({ remove: () => {} }),
  }
}

describe('css-interop native colorScheme.set', () => {
  test("clears the override with 'unspecified', not null, for system", () => {
    const appearance = fakeAppearance('dark')
    observables.colorScheme[INTERNAL_RESET](appearance)

    observables.colorScheme.set('system')

    expect(appearance.calls).toEqual(['unspecified'])
    // (`colorScheme.get()` is forced to light under NODE_ENV=test, so read the
    // system observable that real devices use.)
    expect(observables.systemColorScheme.get()).toBe('dark')
  })

  test('passes explicit light and dark through', () => {
    const appearance = fakeAppearance('dark')
    observables.colorScheme[INTERNAL_RESET](appearance)

    observables.colorScheme.set('light')
    expect(appearance.calls).toEqual(['light'])
    expect(observables.colorScheme.get()).toBe('light')

    observables.colorScheme.set('dark')
    expect(observables.colorScheme.get()).toBe('dark')
  })
})
