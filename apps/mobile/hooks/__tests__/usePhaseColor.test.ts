// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect } from 'bun:test'
import { renderHook } from '@testing-library/react'

import { usePhaseColor, getPhaseColors, type PhaseColors } from '../usePhaseColor'

const EXPECTED_DISCOVERY: PhaseColors = {
  bg: 'bg-blue-500',
  text: 'text-blue-500',
  border: 'border-blue-500',
  ring: 'ring-blue-500',
  accent: 'bg-blue-100 text-blue-800',
}

const EXPECTED_DESIGN: PhaseColors = {
  bg: 'bg-purple-500',
  text: 'text-purple-500',
  border: 'border-purple-500',
  ring: 'ring-purple-500',
  accent: 'bg-purple-100 text-purple-800',
}

const EXPECTED_IMPLEMENTATION: PhaseColors = {
  bg: 'bg-green-500',
  text: 'text-green-500',
  border: 'border-green-500',
  ring: 'ring-green-500',
  accent: 'bg-green-100 text-green-800',
}

const NEUTRAL: PhaseColors = {
  bg: 'bg-gray-500',
  text: 'text-gray-500',
  border: 'border-gray-500',
  ring: 'ring-gray-500',
  accent: 'bg-gray-100 text-gray-800',
}

describe('getPhaseColors (pure)', () => {
  test('returns discovery colors', () => {
    expect(getPhaseColors('discovery')).toEqual(EXPECTED_DISCOVERY)
  })

  test('returns design colors', () => {
    expect(getPhaseColors('design')).toEqual(EXPECTED_DESIGN)
  })

  test('returns implementation colors', () => {
    expect(getPhaseColors('implementation')).toEqual(EXPECTED_IMPLEMENTATION)
  })

  test('returns neutral colors for unknown phase', () => {
    expect(getPhaseColors('unknown')).toEqual(NEUTRAL)
  })

  test('returns neutral colors for empty string', () => {
    expect(getPhaseColors('')).toEqual(NEUTRAL)
  })
})

describe('usePhaseColor (hook)', () => {
  test('returns correct colors for a known phase', () => {
    const { result } = renderHook(() => usePhaseColor('discovery'))
    expect(result.current).toEqual(EXPECTED_DISCOVERY)
  })

  test('returns neutral for an unknown phase', () => {
    const { result } = renderHook(() => usePhaseColor('nonexistent'))
    expect(result.current).toEqual(NEUTRAL)
  })

  test('updates when phase changes', () => {
    const { result, rerender } = renderHook(
      ({ phase }) => usePhaseColor(phase),
      { initialProps: { phase: 'discovery' } },
    )
    expect(result.current).toEqual(EXPECTED_DISCOVERY)

    rerender({ phase: 'design' })
    expect(result.current).toEqual(EXPECTED_DESIGN)
  })
})
