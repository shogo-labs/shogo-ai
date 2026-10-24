// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from "react"
import type { LayoutChangeEvent } from "react-native"

/**
 * Width of the view the returned `onLayout` is attached to. A thread sidebar or
 * a side panel is narrower than the window, so anything that has to fit the
 * space a message actually got reads this instead of `useWindowDimensions`.
 * Until the first layout pass it reports `initial`.
 */
export function useMeasuredWidth(initial = 0) {
  const [width, setWidth] = useState(initial)
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width)
    setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next))
  }, [])
  return { width, onLayout }
}
