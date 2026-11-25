// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Recognises "two presses in a row" on a web drag handle from pointer events.
 *
 * react-native-web forwards no `onDoubleClick` to the DOM, and a handle that
 * appends a full-viewport overlay on pointerdown takes the pointerup that would
 * make the browser count a second `click` or dispatch `dblclick`. The presses
 * are counted here instead: a press that lands within `DOUBLE_CLICK_MS` of one
 * released in place is the second half of a double-click.
 *
 * A press that moved is a drag, never a click, so it can neither complete a
 * double-click nor be its first half. Drift under `CLICK_DRIFT_PX` is trackpad
 * tremor: it keeps a press a click, and it does not resize anything.
 */
import { useCallback, useRef } from 'react'

/** A press this soon after a click on a handle is the second half of a double-click. */
export const DOUBLE_CLICK_MS = 350

/** Pointer travel this small is tremor, not a drag. */
export const CLICK_DRIFT_PX = 3

type PressPoint = { clientX: number; clientY: number }

export function usePressCounter(onDoubleClick: () => void) {
  const lastClickAtRef = useRef(0)
  const startPointRef = useRef<PressPoint | null>(null)
  const movedRef = useRef(false)

  /**
   * Call from pointerdown. Returns true when the press was the second half of a
   * double-click and `onDoubleClick` consumed it — the caller must not start a
   * drag for it.
   */
  const beginPress = useCallback(
    (point: PressPoint) => {
      const pressedAt = Date.now()
      if (lastClickAtRef.current > 0 && pressedAt - lastClickAtRef.current < DOUBLE_CLICK_MS) {
        // Consume the resetting press too: leaving the old timestamp here would
        // keep resetting on a burst of fast presses instead of starting over.
        lastClickAtRef.current = 0
        startPointRef.current = null
        movedRef.current = false
        onDoubleClick()
        return true
      }
      lastClickAtRef.current = 0
      startPointRef.current = { clientX: point.clientX, clientY: point.clientY }
      movedRef.current = false
      return false
    },
    [onDoubleClick],
  )

  /** Call from pointermove. Returns true once the press has travelled past the click drift, i.e. it is a drag. */
  const movePress = useCallback((point: PressPoint) => {
    if (movedRef.current) return true
    const start = startPointRef.current
    if (!start) return false
    if (
      Math.abs(point.clientX - start.clientX) > CLICK_DRIFT_PX ||
      Math.abs(point.clientY - start.clientY) > CLICK_DRIFT_PX
    ) {
      movedRef.current = true
    }
    return movedRef.current
  }, [])

  /**
   * Call from pointerup. Returns true when the press was released in place (a
   * click) — it becomes the first half of a double-click, and it is not a
   * resize.
   */
  const endPress = useCallback(() => {
    const wasClick = !movedRef.current
    startPointRef.current = null
    movedRef.current = false
    if (wasClick) lastClickAtRef.current = Date.now()
    return wasClick
  }, [])

  return { beginPress, movePress, endPress }
}
