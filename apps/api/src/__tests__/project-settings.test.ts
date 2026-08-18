// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { normalizeProjectSettings, parseProjectSettings } from '../lib/project-settings'

describe('parseProjectSettings', () => {
  test('returns objects untouched (marketplace install shape)', () => {
    const settings = { activeMode: 'canvas', techStackId: 'expo-app' }
    expect(parseProjectSettings(settings)).toEqual(settings)
  })

  test('decodes the JSON string shape that Postgres hands back', () => {
    // The bug this guards: every client write path sends
    // JSON.stringify(settings), Postgres stores it as a jsonb string scalar,
    // and a raw `settings?.techStackId` read silently yields undefined.
    const raw = JSON.stringify({ activeMode: 'canvas', techStackId: 'expo-app' })
    expect(parseProjectSettings(raw)?.techStackId).toBe('expo-app')
  })

  test('unwraps repeated encoding up to the depth bound', () => {
    const once = JSON.stringify({ techStackId: 'expo-app' })
    expect(parseProjectSettings(JSON.stringify(once))?.techStackId).toBe('expo-app')

    let overNested = JSON.stringify({ techStackId: 'expo-app' })
    for (let i = 0; i < 6; i++) overNested = JSON.stringify(overNested)
    expect(parseProjectSettings(overNested)).toBeNull()
  })

  test('returns null for absent, malformed, and non-object values', () => {
    expect(parseProjectSettings(null)).toBeNull()
    expect(parseProjectSettings(undefined)).toBeNull()
    expect(parseProjectSettings('{not valid json')).toBeNull()
    expect(parseProjectSettings('"canvas"')).toBeNull()
    expect(parseProjectSettings(42)).toBeNull()
    expect(parseProjectSettings(JSON.stringify([1, 2]))).toBeNull()
  })
})

describe('normalizeProjectSettings', () => {
  test('converts a stringified payload into the object the column expects', () => {
    const result = normalizeProjectSettings(
      JSON.stringify({ activeMode: 'canvas', techStackId: 'expo-app' }),
    )
    expect(result).toEqual({ activeMode: 'canvas', techStackId: 'expo-app' })
  })

  test('passes through objects and non-decodable strings unchanged', () => {
    const obj = { activeMode: 'canvas' }
    expect(normalizeProjectSettings(obj)).toBe(obj)
    expect(normalizeProjectSettings('{not valid json')).toBe('{not valid json')
    expect(normalizeProjectSettings(null)).toBeNull()
  })
})
