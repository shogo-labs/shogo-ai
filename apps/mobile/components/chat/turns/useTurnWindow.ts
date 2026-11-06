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
 * 1. **The window follows the tail.** The number of turns mounted *beyond* the
 *    tail window is the only state (`extra`), so the start index is derived
 *    from the current turn count on every render. A chat that grows after
 *    mount — the live/resuming case — keeps exactly `TURN_WINDOW_SIZE` turns
 *    mounted instead of mounting everything it has received so far.
 * 2. **Nothing the person is reading moves.** A turn that mounts above the
 *    visible ones is first represented in the spacer by an estimate; when its
 *    real height arrives the content above the reader has changed by
 *    `real - estimate`, which is reported through `onContentShift` so the
 *    caller can scroll back by the same amount. Estimates therefore never
 *    cause a jump — they only shape the scrollbar until the turn is measured.
 *
 * Height measurements come from `onLayout`, which is worth a note on web:
 * react-native-web drives it from a `ResizeObserver` (size changes only), so
 * it reports a newly mounted turn's height but never a turn that merely moved.
 * That is why the correction is derived from `real - estimate` rather than
 * from tracking a reference element's position.
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
 * turns above the *first* mounted window; the shift accounting absorbs the
 * error the moment the real height is measured.
 */
export const TURN_WINDOW_ESTIMATE = 280
/** Minimum gap between two expansions, so a fling can't mount the lot. */
const EXPAND_THROTTLE_MS = 150

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
  /** Layout handler a mounted turn must attach to report its height. */
  onTurnLayout: (id: string) => (event: LayoutChangeEvent) => void
}

export function useTurnWindow({
  turns,
  resetKey = null,
  editingIndex,
  scrollSignal,
  onContentShift,
}: TurnWindowOptions): TurnWindow {
  const count = turns.length
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  const [windowState, setWindowState] = useState(() => ({
    key: resetKey,
    /** Turns mounted *above* the tail window — 0 means "just the tail". */
    extra: 0,
  }))

  // A different chat starts from a fresh tail window. Adjusting state during
  // render is the documented way to react to a prop change; the key guard is
  // what stops it from looping.
  let state = windowState
  if (state.key !== resetKey) {
    state = { key: resetKey, extra: 0 }
    setWindowState(state)
  }

  const setExtra = useCallback((next: number) => {
    setWindowState((current) => {
      const clamped = Math.max(0, next)
      return clamped === current.extra ? current : { ...current, extra: clamped }
    })
  }, [])

  // Derived on every render from the *current* count, so the window can never
  // fall behind a transcript that grows after mount.
  const tailStart = Math.max(0, count - TURN_WINDOW_SIZE)
  const windowStart = Math.max(0, tailStart - state.extra)
  const editingStart =
    editingIndex != null && editingIndex >= 0 ? editingIndex : Number.POSITIVE_INFINITY
  const start = Math.min(windowStart, editingStart)

  const startRef = useRef(start)
  startRef.current = start
  const extraRef = useRef(state.extra)
  extraRef.current = state.extra
  const countRef = useRef(count)
  countRef.current = count
  const spacerHeightRef = useRef(0)

  const heightsRef = useRef(new Map<string, number>())
  /** Turns mounted above the reader whose height is still an estimate. */
  const pendingRef = useRef(new Map<string, number>())
  const lastExpandAtRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [])

  const onTurnLayout = useCallback(
    (id: string) => (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout
      heightsRef.current.set(id, height)
      const baseline = pendingRef.current.get(id)
      if (baseline === undefined) return
      pendingRef.current.delete(id)
      const dy = height - baseline
      if (Math.abs(dy) > 0.5) onContentShift?.(dy)
    },
    [onContentShift],
  )

  const expand = useCallback(
    function expand() {
      const current = startRef.current
      if (current <= 0) return
      const nextStart = Math.max(0, current - TURN_WINDOW_STEP)
      // Everything between the new start and the current one is about to mount
      // above the reader: remember what the spacer was charging for it so its
      // real height can be reconciled the moment it is measured.
      for (let index = nextStart; index < current; index++) {
        const id = turnsRef.current[index]?.id
        if (!id) continue
        pendingRef.current.set(
          id,
          heightsRef.current.get(id) ?? TURN_WINDOW_ESTIMATE,
        )
      }
      lastExpandAtRef.current = Date.now()
      setExtra(extraRef.current + (current - nextStart))
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      // A fling can land straight at the very top of the collapsed region,
      // where no further scroll event will arrive. Keep pulling the window
      // open, one throttled step at a time, until the person is out of it.
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        const sample = scrollSignal?.read()
        if (!sample) return
        const windowTop = spacerHeightRef.current
        const nearWindowTop =
          sample.y + sample.viewportHeight > windowTop - TURN_WINDOW_TOP_EDGE
        if (nearWindowTop && startRef.current > 0) {
          lastExpandAtRef.current = 0
          expand()
        }
      }, EXPAND_THROTTLE_MS)
    },
    [scrollSignal, setExtra],
  )

  useEffect(() => {
    if (!scrollSignal) return
    return scrollSignal.subscribe(() => {
      const { y, viewportHeight, contentHeight } = scrollSignal.read()
      const current = startRef.current

      // Expand when the *top of the mounted window* comes near the bottom of
      // the viewport — not when the scroll offset nears zero. The collapsed
      // spacer sits between the two and is usually far taller than one screen,
      // so waiting for `y ≈ 0` would let the person scroll into blank space for
      // thousands of pixels before history came back.
      const nearWindowTop =
        y + viewportHeight > spacerHeightRef.current - TURN_WINDOW_TOP_EDGE
      if (nearWindowTop && current > 0) {
        if (Date.now() - lastExpandAtRef.current < EXPAND_THROTTLE_MS) return
        expand()
        return
      }

      const nearBottom =
        contentHeight - y - viewportHeight < TURN_WINDOW_BOTTOM_EDGE
      if (nearBottom && extraRef.current !== 0) {
        setExtra(0)
      }
    })
  }, [scrollSignal, expand, setExtra])

  let spacerHeight = 0
  for (let index = 0; index < start; index++) {
    spacerHeight += heightsRef.current.get(turns[index].id) ?? TURN_WINDOW_ESTIMATE
  }
  spacerHeightRef.current = spacerHeight

  return { start, spacerHeight, onTurnLayout }
}
