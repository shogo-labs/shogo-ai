// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useRef, useState } from "react"

/**
 * Throttle a streaming value so heavy downstream work (markdown parsing, part
 * extraction, JSX reconciliation for tool widgets) only fires at ~`intervalMs`
 * cadence instead of on every token. When `throttle` flips false (stream
 * ended), the latest value is flushed synchronously so the final snapshot is
 * always pixel-correct.
 *
 * The component's render function still runs on every parent re-render (cheap),
 * but any `useMemo`/`memo` keyed on the returned throttled value gets its
 * cached result back, which is where the per-token 50–260ms cost was
 * concentrated (Streamdown re-parsing the full message text per character).
 *
 * While streaming, updates always go through a timer and never `setState`
 * inside the effect: an effect that sets state after every streamed commit
 * leaves work pending behind each one, and React counts a run of such commits
 * toward its "Maximum update depth exceeded" limit (#1083).
 */
export const STREAMING_THROTTLE_MS = 50

export function useThrottledWhileStreaming<T>(
  value: T,
  isStreaming: boolean,
  intervalMs: number = STREAMING_THROTTLE_MS,
): T {
  const [throttled, setThrottled] = useState<T>(value)
  const lastEmitAtRef = useRef(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestValueRef = useRef(value)
  latestValueRef.current = value

  useEffect(() => {
    if (!isStreaming) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      lastEmitAtRef.current = performance.now()
      setThrottled(value)
      return
    }

    if (pendingTimerRef.current === null) {
      const elapsed = performance.now() - lastEmitAtRef.current
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null
        lastEmitAtRef.current = performance.now()
        setThrottled(latestValueRef.current)
      }, Math.max(0, intervalMs - elapsed))
    }
  }, [value, isStreaming, intervalMs])

  useEffect(
    () => () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
      }
    },
    [],
  )

  return throttled
}
