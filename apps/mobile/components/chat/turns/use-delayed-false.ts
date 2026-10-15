// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useRef, useState } from "react"

/**
 * Hold a boolean's previous `true` for `delayMs` after it transitions to
 * `false`. Rising edges (`false` → `true`) are instantaneous, so a fresh
 * tool call relights the "streaming" state immediately, but the falling
 * edge waits — preventing the Editing… / Exploring… header from
 * flickering to its summary form during the brief gap between
 * consecutive tool calls in the same agent turn.
 *
 * State is only set on a transition, never on a re-render with an unchanged
 * value, so streamed commits don't leave an update pending behind them.
 */
export function useDelayedFalse(value: boolean, delayMs: number): boolean {
  const [stable, setStable] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (!stable) setStable(true)
      return
    }
    if (!stable) return
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setStable(false)
    }, delayMs)
  }, [value, delayMs, stable])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    },
    [],
  )

  return stable
}
