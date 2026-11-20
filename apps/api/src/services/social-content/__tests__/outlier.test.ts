// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the pure outlier-scoring helpers.
 * Run: bun test apps/api/src/services/social-content/__tests__/outlier.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { median, outlierScore } from '../outlier'

describe('median', () => {
  test('returns null for empty array', () => {
    expect(median([])).toBeNull()
  })

  test('returns single value', () => {
    expect(median([42])).toBe(42)
  })

  test('returns middle value for odd-length array', () => {
    expect(median([1, 3, 5])).toBe(3)
  })

  test('returns average of two middle values for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  test('sorts before computing (order invariant)', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([100, 1, 50])).toBe(50)
  })

  test('handles all same values', () => {
    expect(median([10, 10, 10])).toBe(10)
  })
})

describe('outlierScore', () => {
  test('returns null when medianViews is null', () => {
    expect(outlierScore(10000, null)).toBeNull()
  })

  test('returns null when medianViews is 0', () => {
    expect(outlierScore(10000, 0)).toBeNull()
  })

  test('returns null when medianViews is negative', () => {
    expect(outlierScore(10000, -1)).toBeNull()
  })

  test('1.0 when views equals median', () => {
    expect(outlierScore(5000, 5000)).toBe(1.0)
  })

  test('rounds to 2 decimal places', () => {
    expect(outlierScore(10000, 3000)).toBe(3.33)
  })

  test('a 10× viral post scores 10', () => {
    expect(outlierScore(100_000, 10_000)).toBe(10.0)
  })

  test('below-average post scores < 1', () => {
    expect(outlierScore(500, 2000)).toBe(0.25)
  })
})
