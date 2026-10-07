// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { startTransition, useEffect, useRef, useState } from "react"

/** Work-log items rendered at once when a long turn arrives in one update. */
export const BACKLOG_WINDOW = 12

/**
 * How many leading work-log items to leave out of this render. Reconnecting
 * to a running turn delivers its whole history in one update; rendering every
 * step in the same commit as the live text delays that text by seconds on a
 * phone. The first commit shows the last BACKLOG_WINDOW items and the live
 * text, and the earlier steps render in a transition right after.
 */
export function useDeferredBacklog(length: number, isStreaming: boolean): number {
  const renderedLength = useRef(0)
  const [, reveal] = useState(0)
  const hidden =
    isStreaming && length - renderedLength.current > BACKLOG_WINDOW ? length - BACKLOG_WINDOW : 0
  useEffect(() => {
    if (hidden === 0) {
      renderedLength.current = length
      return
    }
    const timer = setTimeout(() => {
      startTransition(() => {
        renderedLength.current = length
        reveal((n) => n + 1)
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [hidden, length])
  return hidden
}
