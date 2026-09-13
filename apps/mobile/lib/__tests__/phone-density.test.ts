// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { COMPACT_DENSITY, PHONE_DENSITY, ACCOUNT_SHEET_DENSITY, densityFor } from '../phone-density'

describe('PHONE_DENSITY', () => {
  test('is larger than compact chrome without dropping required slots', () => {
    expect(PHONE_DENSITY.icon.nav).toBeGreaterThan(COMPACT_DENSITY.icon.nav)
    expect(PHONE_DENSITY.icon.lg).toBeGreaterThan(COMPACT_DENSITY.icon.lg)
    expect(PHONE_DENSITY.icon.md).toBeGreaterThan(COMPACT_DENSITY.icon.md)
    expect(PHONE_DENSITY.text.body).not.toBe(COMPACT_DENSITY.text.body)
    expect(PHONE_DENSITY.hit).toContain(PHONE_DENSITY.hitSize)
    expect(PHONE_DENSITY.hitSize).toBe('h-12 w-12')
    expect(PHONE_DENSITY.rowMin).toBe('min-h-12')
  })

  test('account sheets bump chrome one step above phone rows', () => {
    expect(ACCOUNT_SHEET_DENSITY.icon.md).toBeGreaterThan(PHONE_DENSITY.icon.md)
    expect(ACCOUNT_SHEET_DENSITY.text.title).not.toBe(PHONE_DENSITY.text.title)
  })

  test('densityFor picks the phone table only when comfortable is true', () => {
    expect(densityFor(true)).toBe(PHONE_DENSITY)
    expect(densityFor(false)).toBe(COMPACT_DENSITY)
  })
})
