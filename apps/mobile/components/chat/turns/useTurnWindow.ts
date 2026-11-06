// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Windowed transcript (SHO-354).
 *
 * A chat keeps every turn it has ever loaded mounted, so opening and scrolling
 * a long history pays for thousands of markdown trees the person will never
 * look at. This hook keeps a bounded window of turns mounted and replaces the
 * rest with a single spacer.
 *
 * Two invariants make that safe:
 *
 * 1. **Nothing the person is reading moves.** The hook holds one *anchor*
 *    turn — the topmost mounted one — and watches its measured offset inside
 *    the list. Any change above it (older turns mounting, an estimate being
 *    replaced by the real height, an image finishing layout) shifts that
 *    offset by exactly the amount the visible content moved, so the caller can
 *    scroll back by the same delta. This is why an estimate is never allowed
 *    to cause a jump: the estimate only sets the scrollbar's shape until the
 *    turn is really measured.
 * 2. **The tail is always mounted.** The window covers the newest turns, so
 *    stick-to-bottom, the streaming reply and the rejoin row keep working
 *    exactly as before.
 *
 * The window grows upwards when the person scrolls near the top (mounting more
 * of the history that is already in memory, no server round-trip) and shrinks
 * back to the tail window when they return to the bottom.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { LayoutChangeEvent } from "react-native"
import type { TranscriptScrollSignal } from "./transcript-scroll"

/** Turns kept mounted at the tail. */
export const TURN_WINDOW_SIZE = 30
/** Turns mounted per expansion while scrolling up. */
export const TURN_WINDOW_STEP = 20
/** Distance (px) from the top of the transcript that triggers an expansion. */
export const TURN_WINDOW_TOP_EDGE = 600
/** Distance (px) from the bottom that lets the window shrink back to the tail. */
export const TURN_WINDOW_BOTTOM_EDGE = 240
/**
 * Height given to a turn that has never been laid out. Only ever wrong for
 * turns above the *first* mounted window; the anchor correction absorbs the
 * error the moment the real height is measured.
 */
export const TURN_WINDOW_ESTIMATE = 280
/** Minimum gap between two expansions, so a fling can't mount the lot. */
const EXPAND_THROTTLE_MS = 150
/** Turns that stay mounted below the window even while the person reads back. */
const TAIL_ALWAYS_MOUNTED = 3

export interface TurnWindowOptions {
  /** Turn ids in transcript order (oldest first). */
  turns: readonly { id: string }[]
  /** Changing this resets the window (a different chat was opened). */
  resetKey?: string | null
  /** Turn index that must stay mounted because the in-place editor owns it. */
  editingIndex?: number
  /** Where the ScrollView currently is. Optional: without it nothing re-expands. */
  scrollSignal?: TranscriptScrollSignal | null
  /**
   * Scroll the transcript by `dy` px — called when content *above* the
   * visible turns changed height. Implementations must ignore it while the
   * transcript is following the bottom.
   */
  onContentShift?: (dy: number) => void
}

export interface TurnWindow {
  /** First mounted turn index. Turns before it are collapsed into the spacer. */
  start: number
  /** Height reserved for the collapsed turns above the window. */
  spacerHeight: number
  /** Layout handler a mounted turn must attach to report its height/offset. */
  onTurnLayout: (id: string) => (event: LayoutChangeEvent) => void
  /**
   * Layout handler for the list root: its `y` is where the list starts inside
   * the scroll content, which is what turns the spacer height into a scroll
   * offset the window can react to.
   */
  onRootLayout: (event: LayoutChangeEvent) => void
}

export function useTurnWindow({
  turns,
  resetKey = null,
  editingIndex,
  scrollSignal,
  onContentShift,
}: TurnWindowOptions): TurnWindow {
  const count = turns.length

  const [state, setState] = useState(() => ({
    key: resetKey,
    start: Math.max(0, count - TURN_WINDOW_SIZE),
  }))

  // A different chat starts from a fresh tail window. Adjusting state during
  // render is the documented way to react to a prop change; the key guard is
  // what stops it from looping.
  let windowState = state
  if (windowState.key !== resetKey) {
    windowState = { key: resetKey, start: Math.max(0, count - TURN_WINDOW_SIZE) }
    setState(windowState)
  }

  const setWindowStart = useCallback((next: number) => {
    setState((current) => {
      const clamped = Math.max(0, next)
      return clamped === current.start ? current : { ...current, start: clamped }
    })
  }, [])

  const tailStart = Math.max(0, count - TAIL_ALWAYS_MOUNTED)
  const editingStart =
    editingIndex != null && editingIndex >= 0 ? editingIndex : Number.POSITIVE_INFINITY
  const start = Math.min(windowState.start, tailStart, editingStart)

  const startRef = useRef(start)
  startRef.current = start
  const countRef = useRef(count)
  countRef.current = count

  const heightsRef = useRef(new Map<string, number>())
  const anchorIdRef = useRef<string | null>(null)
  const anchorOffsetRef = useRef<number | null>(null)
  const topIdRef = useRef<string | null>(turns[start]?.id ?? null)
  topIdRef.current = turns[start]?.id ?? null
  /** Where the list itself starts inside the scroll content. */
  const listTopRef = useRef(0)
  const spacerHeightRef = useRef(0)
  const lastExpandAtRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Drop an anchor that fell out of the window; the next mounted turn becomes
  // the new reference and its first measurement is its baseline.
  useEffect(() => {
    const anchor = anchorIdRef.current
    if (!anchor) return
    const index = turns.findIndex((turn) => turn.id === anchor)
    if (index < start) {
      anchorIdRef.current = null
      anchorOffsetRef.current = null
    }
  }, [start, turns])

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [])

  const onTurnLayout = useCallback(
    (id: string) => (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout
      heightsRef.current.set(id, height)
      // The topmost mounted turn becomes the anchor the first time it is laid
      // out; from then on it is the position the transcript holds still.
      if (anchorIdRef.current == null) {
        if (id !== topIdRef.current) return
        anchorIdRef.current = id
        anchorOffsetRef.current = y
        return
      }
      if (anchorIdRef.current !== id) return
      const previous = anchorOffsetRef.current
      anchorOffsetRef.current = y
      if (previous == null) return
      const dy = y - previous
      if (Math.abs(dy) > 0.5) onContentShift?.(dy)
    },
    [onContentShift],
  )

  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    listTopRef.current = event.nativeEvent.layout.y
  }, [])

  const expand = useCallback(
    function expand() {
      const current = startRef.current
      if (current <= 0) return
      lastExpandAtRef.current = Date.now()
      setWindowStart(current - TURN_WINDOW_STEP)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      // A fling can land straight at the very top of the collapsed region,
      // where no further scroll event will arrive. Keep pulling the window
      // open, one throttled step at a time, until the person is out of it.
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        const sample = scrollSignal?.read()
        if (!sample) return
        const windowTop = listTopRef.current + spacerHeightRef.current
        const nearWindowTop =
          sample.y + sample.viewportHeight > windowTop - TURN_WINDOW_TOP_EDGE
        if (nearWindowTop && startRef.current > 0) {
          lastExpandAtRef.current = 0
          expand()
        }
      }, EXPAND_THROTTLE_MS)
    },
    [scrollSignal, setWindowStart],
  )

  useEffect(() => {
    if (!scrollSignal) return
    return scrollSignal.subscribe(() => {
      const { y, viewportHeight, contentHeight } = scrollSignal.read()
      const current = startRef.current
      const total = countRef.current

      // Expand when the *top of the mounted window* comes near the bottom of
      // the viewport — not when the scroll offset nears zero. The collapsed
      // spacer sits between the two, and it is usually far taller than one
      // screen, so waiting for `y ≈ 0` would let the person scroll into blank
      // space for thousands of pixels before history came back.
      const windowTop = listTopRef.current + spacerHeightRef.current
      const nearWindowTop =
        y + viewportHeight > windowTop - TURN_WINDOW_TOP_EDGE
      if (nearWindowTop && current > 0) {
        if (Date.now() - lastExpandAtRef.current < EXPAND_THROTTLE_MS) return
        expand()
        return
      }

      const tailWindow = Math.max(0, total - TURN_WINDOW_SIZE)
      const nearBottom =
        contentHeight - y - viewportHeight < TURN_WINDOW_BOTTOM_EDGE
      if (nearBottom && current < tailWindow) {
        setWindowStart(tailWindow)
      }
    })
  }, [scrollSignal, expand, setWindowStart])

  let spacerHeight = 0
  for (let index = 0; index < start; index++) {
    spacerHeight += heightsRef.current.get(turns[index].id) ?? TURN_WINDOW_ESTIMATE
  }
  spacerHeightRef.current = spacerHeight

  return { start, spacerHeight, onTurnLayout, onRootLayout }
}
