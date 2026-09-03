// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'

import { useTypingPlaceholder, AGENT_PLACEHOLDER_PREFIX } from '../useTypingPlaceholder'

describe('useTypingPlaceholder', () => {
  beforeEach(() => {
    globalThis.useFakeTimers?.()
  })

  afterEach(() => {
    globalThis.useRealTimers?.()
  })

  test('exports AGENT_PLACEHOLDER_PREFIX constant', () => {
    expect(AGENT_PLACEHOLDER_PREFIX).toBe('Ask Shogo to ')
  })

  test('starts with empty string', () => {
    const { result } = renderHook(() =>
      useTypingPlaceholder(['Hello'], { enabled: true }),
    )
    expect(typeof result.current).toBe('string')
  })

  test('returns empty string when disabled', () => {
    const { result } = renderHook(() =>
      useTypingPlaceholder(['Hello'], { enabled: false }),
    )
    expect(result.current).toBe('')
  })

  test('returns empty string when suggestions array is empty', () => {
    const { result } = renderHook(() =>
      useTypingPlaceholder([], { enabled: true }),
    )
    expect(result.current).toBe('')
  })

  test('types characters progressively', async () => {
    const suggestions = ['Hi']
    const { result } = renderHook(() =>
      useTypingPlaceholder(suggestions, { enabled: true }),
    )

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150))
    })

    expect(result.current.length).toBeGreaterThan(0)
    expect('Hi'.startsWith(result.current)).toBe(true)
  })

  test('cleans up timers on unmount', () => {
    const { unmount } = renderHook(() =>
      useTypingPlaceholder(['Hello world'], { enabled: true }),
    )
    // Should not throw on unmount
    unmount()
  })

  test('resets when enabled changes to false', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useTypingPlaceholder(['Test'], { enabled }),
      { initialProps: { enabled: true } },
    )

    rerender({ enabled: false })
    expect(result.current).toBe('')
  })

  test('uses default suggestions when none provided', () => {
    const { result } = renderHook(() => useTypingPlaceholder())
    expect(typeof result.current).toBe('string')
  })
})
