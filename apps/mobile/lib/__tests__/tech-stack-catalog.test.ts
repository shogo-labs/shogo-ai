// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  FALLBACK_TECH_STACKS,
  mergeTechStacks,
  techStackDisplayName,
} from '../tech-stack-catalog'

describe('techStackDisplayName', () => {
  test('resolves known ids from the fallback catalog', () => {
    expect(techStackDisplayName('react-app')).toBe('React App')
    expect(techStackDisplayName('expo-app')).toBe('Expo (React Native)')
    expect(techStackDisplayName('missing')).toBe('Stack')
    expect(techStackDisplayName(undefined)).toBe('Stack')
  })
})

describe('mergeTechStacks', () => {
  test('keeps the accordion populated when the API is empty or missing', () => {
    expect(mergeTechStacks(undefined)).toEqual(FALLBACK_TECH_STACKS)
    expect(mergeTechStacks([])).toEqual(FALLBACK_TECH_STACKS)
  })

  test('uses the fetched list when it has stacks', () => {
    const fetched = [{ id: 'react-app', name: 'React App', description: '', tags: [] }]
    expect(mergeTechStacks(fetched)).toEqual(fetched)
  })
})
