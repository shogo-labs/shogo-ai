// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { safeGetItem, safeRemoveItem, safeSetItem } from '../../../lib/safe-storage'

mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }))

const { useSidePaneWidth } = await import('../SidePaneResizer')

const KEY = 'shogo.teamChat.testPaneWidth'

function useWidth(maxWidth = 800, defaultWidth = 420) {
  return useSidePaneWidth({
    storageKey: KEY,
    defaultWidth,
    minWidth: 320,
    maxWidth,
  })
}

afterEach(() => {
  cleanup()
  safeRemoveItem(KEY)
})

describe('useSidePaneWidth', () => {
  test('restores a saved width', () => {
    safeSetItem(KEY, '560')
    const { result } = renderHook(() => useWidth())
    expect(result.current.width).toBe(560)
  })

  test('clamps a saved width that falls outside the current range', () => {
    safeSetItem(KEY, '900')
    const { result, rerender } = renderHook(({ maxWidth }) => useWidth(maxWidth), {
      initialProps: { maxWidth: 640 },
    })
    expect(result.current.width).toBe(640)

    safeRemoveItem(KEY)
    safeSetItem(KEY, '100')
    rerender({ maxWidth: 640 })
    const below = renderHook(() => useWidth(640))
    expect(below.result.current.width).toBe(320)
    below.unmount()
  })

  test('reclamps when the window gets narrower, then restores the preference when it widens', () => {
    safeSetItem(KEY, '700')
    const { result, rerender } = renderHook(({ maxWidth }) => useWidth(maxWidth), {
      initialProps: { maxWidth: 800 },
    })
    expect(result.current.width).toBe(700)
    rerender({ maxWidth: 500 })
    expect(result.current.width).toBe(500)
    rerender({ maxWidth: 800 })
    expect(result.current.width).toBe(700)
  })

  test('ignores an invalid saved value and follows the default', () => {
    safeSetItem(KEY, 'nope')
    const { result, rerender } = renderHook(({ defaultWidth }) => useWidth(800, defaultWidth), {
      initialProps: { defaultWidth: 420 },
    })
    expect(result.current.width).toBe(420)
    rerender({ defaultWidth: 480 })
    expect(result.current.width).toBe(480)
  })

  test('commit remembers the dragged width', () => {
    const { result } = renderHook(() => useWidth())
    act(() => result.current.commit(610))
    expect(result.current.width).toBe(610)
    expect(safeGetItem(KEY)).toBe('610')
  })

  test('reset clears the saved width and returns to the default', () => {
    safeSetItem(KEY, '560')
    const { result } = renderHook(() => useWidth())
    act(() => result.current.reset())
    expect(result.current.width).toBe(420)
    expect(safeGetItem(KEY)).toBeNull()
  })
})
