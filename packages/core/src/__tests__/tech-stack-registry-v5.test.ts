// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * tech-stack-registry.ts v5 coverage — closes isMobileTechStack() and
 * usesMetroBundler().
 *
 * Pre-v5: LH=92/94 (97.9%), gapLH=2, gapFN=2. The existing tests cover
 * stack-entry lookups but not these two thin predicates. Six expects
 * pin both targets across mobile / non-mobile / metro / non-metro /
 * null / unknown branches.
 */
import { describe, test, expect } from 'bun:test'
import { isMobileTechStack, usesMetroBundler } from '../tech-stack-registry'

describe('isMobileTechStack', () => {
  test('known mobile stack returns true', () => {
    expect(isMobileTechStack("expo-app")).toBe(true)
  })
  test('web stack returns false', () => {
    expect(isMobileTechStack("react-app")).toBe(false)
  })
  test('null returns false', () => {
    expect(isMobileTechStack(null)).toBe(false)
  })
  test('unknown stack returns false', () => {
    expect(isMobileTechStack('not-a-real-stack')).toBe(false)
  })
})

describe('usesMetroBundler', () => {
  test('expo uses metro', () => {
    expect(usesMetroBundler("expo-app")).toBe(true)
  })
  test('react does not use metro', () => {
    expect(usesMetroBundler("react-app")).toBe(false)
  })
  test('null returns false', () => {
    expect(usesMetroBundler(null)).toBe(false)
  })
})
