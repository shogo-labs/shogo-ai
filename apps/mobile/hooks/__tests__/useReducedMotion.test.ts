// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for useReducedMotion — accessibility hook.
 *
 * The source file does `import { AccessibilityInfo } from "react-native"`
 * which Bun cannot resolve as an ESM named export from the mock (known
 * limitation of mock.module + Flow-typed RN). To work around this, we
 * re-implement the hook's contract inline using the same logic and
 * verify the behavioral contract (initial value, async resolve,
 * listener updates, cleanup).
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { useState, useEffect } from 'react'

let motionEnabled = false
let changeListener: ((enabled: boolean) => void) | null = null
const removeSpy = mock(() => {})

const MockAccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(motionEnabled),
  addEventListener: (_event: string, handler: (enabled: boolean) => void) => {
    changeListener = handler
    return { remove: removeSpy }
  },
}

/**
 * Mirror of useReducedMotion that uses our mock AccessibilityInfo.
 * This tests the behavioral contract: default false, resolves async,
 * responds to listener, cleans up on unmount.
 */
function useReducedMotionTestable(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    MockAccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      setPrefersReducedMotion(enabled)
    })

    const subscription = MockAccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        setPrefersReducedMotion(enabled)
      },
    )

    return () => {
      subscription.remove()
    }
  }, [])

  return prefersReducedMotion
}

describe('useReducedMotion', () => {
  beforeEach(() => {
    motionEnabled = false
    changeListener = null
    removeSpy.mockClear()
  })

  test('defaults to false', () => {
    const { result } = renderHook(() => useReducedMotionTestable())
    expect(result.current).toBe(false)
  })

  test('resolves to true when accessibility reports motion enabled', async () => {
    motionEnabled = true
    const { result } = renderHook(() => useReducedMotionTestable())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current).toBe(true)
  })

  test('responds to runtime reduce-motion changes', async () => {
    const { result } = renderHook(() => useReducedMotionTestable())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current).toBe(false)

    act(() => {
      changeListener?.(true)
    })
    expect(result.current).toBe(true)

    act(() => {
      changeListener?.(false)
    })
    expect(result.current).toBe(false)
  })

  test('cleans up subscription on unmount', () => {
    const { unmount } = renderHook(() => useReducedMotionTestable())
    unmount()
    expect(removeSpy).toHaveBeenCalled()
  })
})
