// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Escape closes a web dialog.
 *
 * Asserted on the extracted hook rather than by rendering the modal: the modal
 * pulls in Animated and the gesture handlers the preload deliberately leaves
 * out (see `test/testing-library.ts`).
 *
 * Run: bun --no-env-file ../../scripts/run-tests-isolated.ts . --roots lib/__tests__/use-escape-to-close.test.ts
 */

import { describe, expect, mock, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'

import { useEscapeToClose } from '../use-escape-to-close'

const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }))
  })
}

describe('useEscapeToClose', () => {
  test('calls onClose on Escape while visible', () => {
    const onClose = mock(() => {})
    renderHook(() => useEscapeToClose(true, onClose))

    press('Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('ignores Escape while hidden', () => {
    const onClose = mock(() => {})
    renderHook(() => useEscapeToClose(false, onClose))

    press('Escape')

    expect(onClose).not.toHaveBeenCalled()
  })

  test('ignores other keys', () => {
    const onClose = mock(() => {})
    renderHook(() => useEscapeToClose(true, onClose))

    press('a')
    press('Enter')

    expect(onClose).not.toHaveBeenCalled()
  })

  test('stops listening once unmounted', () => {
    const onClose = mock(() => {})
    const { unmount } = renderHook(() => useEscapeToClose(true, onClose))

    unmount()
    press('Escape')

    expect(onClose).not.toHaveBeenCalled()
  })

  test('stops listening once hidden, resumes when shown again', () => {
    const onClose = mock(() => {})
    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) => useEscapeToClose(visible, onClose),
      { initialProps: { visible: true } },
    )

    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender({ visible: false })
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender({ visible: true })
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  test('always calls the latest onClose', () => {
    const first = mock(() => {})
    const second = mock(() => {})
    const { rerender } = renderHook(
      ({ onClose }: { onClose: () => void }) => useEscapeToClose(true, onClose),
      { initialProps: { onClose: first } },
    )

    rerender({ onClose: second })
    press('Escape')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
