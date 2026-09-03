// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for useGridColumns — responsive breakpoint hook.
 *
 * The hook reads `useWindowDimensions().width` from react-native.
 * The preload stubs react-native but doesn't provide useWindowDimensions,
 * so we augment the mock before importing the hook.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { renderHook } from '@testing-library/react'

let mockWidth = 1024

// The preload already mocked 'react-native'. Bun's mock.module replaces
// the module entirely, so we replicate the essentials from the preload
// plus add useWindowDimensions.
mock.module('react-native', () => ({
  Platform: { OS: 'web', Version: 0, isPad: false, isTV: false, select: <T,>(spec: { web?: T; default?: T }) => spec.web !== undefined ? spec.web : spec.default },
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
  Dimensions: { get: () => ({ width: mockWidth, height: 768, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) },
  useWindowDimensions: () => ({ width: mockWidth, height: 768, scale: 1, fontScale: 1 }),
}))

const { useGridColumns } = await import('../useGridColumns')

describe('useGridColumns', () => {
  beforeEach(() => {
    mockWidth = 1024
  })

  test('returns 1 column for narrow phones (< 480px)', () => {
    mockWidth = 375
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(1)
  })

  test('returns 1 column at boundary (width = 479)', () => {
    mockWidth = 479
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(1)
  })

  test('returns 2 columns for small tablets (480–767px)', () => {
    mockWidth = 480
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(2)
  })

  test('returns 2 columns at upper boundary (width = 767)', () => {
    mockWidth = 767
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(2)
  })

  test('returns 3 columns for tablets (768–1079px)', () => {
    mockWidth = 768
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(3)
  })

  test('returns 3 columns at upper boundary (width = 1079)', () => {
    mockWidth = 1079
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(3)
  })

  test('returns 4 columns for full desktop (>= 1080px)', () => {
    mockWidth = 1080
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(4)
  })

  test('returns 4 columns for wide desktop', () => {
    mockWidth = 1920
    const { result } = renderHook(() => useGridColumns())
    expect(result.current).toBe(4)
  })
})
