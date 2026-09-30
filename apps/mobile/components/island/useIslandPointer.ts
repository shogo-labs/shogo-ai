// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from "react"
import type { IslandBridge, IslandMode } from "./types"

export const HOVER_EXPAND_DELAY_MS = 350
export const HOVER_COLLAPSE_DELAY_MS = 700

/** Elements rendered with these `dataSet` keys become `data-*` attributes on
 * web: `islandSurface` marks hit-testable UI, `islandTrigger` the notch/pill
 * that expands on hover. */
const SURFACE_SELECTOR = "[data-island-surface]"
const TRIGGER_SELECTOR = "[data-island-trigger]"

/**
 * Hover-to-expand and leave-to-collapse for the overlay window. The window
 * is sized to the rendered card, so leaving it means leaving the island.
 * `canAutoCollapse` lets the caller keep the card open while the user is
 * typing, has a pending request, or has a menu open.
 */
export function useIslandPointer({
  bridge,
  mode,
  requestMode,
  canAutoCollapse,
}: {
  bridge: IslandBridge | null
  mode: IslandMode
  requestMode: (mode: IslandMode) => void
  canAutoCollapse: () => boolean
}): void {
  const modeRef = useRef(mode)
  modeRef.current = mode
  const canCollapseRef = useRef(canAutoCollapse)
  canCollapseRef.current = canAutoCollapse
  const requestRef = useRef(requestMode)
  requestRef.current = requestMode

  useEffect(() => {
    if (!bridge || typeof document === "undefined") return
    let lastPoint: { x: number; y: number } | null = null
    let interactive = false
    let expandTimer: ReturnType<typeof setTimeout> | null = null
    let collapseTimer: ReturnType<typeof setTimeout> | null = null

    const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
      if (timer) clearTimeout(timer)
      return null
    }
    const underPointer = () =>
      lastPoint ? document.elementFromPoint(lastPoint.x, lastPoint.y) : null

    const updateInteractive = () => {
      const over = !!underPointer()?.closest(SURFACE_SELECTOR)
      if (over === interactive) return
      interactive = over
      bridge.setInteractive(over)
    }

    const scheduleCollapse = () => {
      collapseTimer ??= setTimeout(() => {
        collapseTimer = null
        if (modeRef.current === "expanded" && canCollapseRef.current()) {
          requestRef.current("collapsed")
        }
      }, HOVER_COLLAPSE_DELAY_MS)
    }

    const handleHover = () => {
      const target = underPointer()
      const current = modeRef.current
      if ((current === "hidden" || current === "collapsed") && target?.closest(TRIGGER_SELECTOR)) {
        expandTimer ??= setTimeout(() => {
          expandTimer = null
          const now = modeRef.current
          if (now === "hidden" || now === "collapsed") requestRef.current("expanded")
        }, HOVER_EXPAND_DELAY_MS)
      } else {
        expandTimer = clear(expandTimer)
      }
      if (current === "expanded" && !target?.closest(SURFACE_SELECTOR)) scheduleCollapse()
      else collapseTimer = clear(collapseTimer)
    }

    const onMove = (event: MouseEvent) => {
      lastPoint = { x: event.clientX, y: event.clientY }
      updateInteractive()
      handleHover()
    }
    const onLeave = () => {
      lastPoint = null
      updateInteractive()
      expandTimer = clear(expandTimer)
      if (modeRef.current === "expanded") scheduleCollapse()
    }

    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseleave", onLeave)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseleave", onLeave)
      clear(expandTimer)
      clear(collapseTimer)
    }
  }, [bridge])
}
