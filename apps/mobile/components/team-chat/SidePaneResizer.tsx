// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drag handle and remembered width for the team-chat side panes (thread and
 * project). The handle is web-only — the desktop app loads the same build —
 * and the width persists through `safe-storage`, which uses localStorage
 * when it is available.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Platform, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { safeGetItem, safeRemoveItem, safeSetItem } from '../../lib/safe-storage'

export function clampSidePaneWidth(value: number, minWidth: number, maxWidth: number): number {
  const upper = Math.max(minWidth, maxWidth)
  return Math.round(Math.min(upper, Math.max(minWidth, value)))
}

function readPreferredWidth(storageKey: string): number | null {
  const raw = safeGetItem(storageKey)
  if (raw == null) return null
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function useSidePaneWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}) {
  // null means "no saved preference": follow defaultWidth, which can change
  // with the window (the project pane defaults to 45%).
  const [preferred, setPreferred] = useState<number | null>(() => readPreferredWidth(storageKey))
  const width = clampSidePaneWidth(preferred ?? defaultWidth, minWidth, maxWidth)

  const setWidth = useCallback((next: number) => {
    setPreferred(next)
  }, [])

  const commit = useCallback(
    (next: number) => {
      const clamped = clampSidePaneWidth(next, minWidth, maxWidth)
      setPreferred(clamped)
      safeSetItem(storageKey, String(clamped))
    },
    [storageKey, minWidth, maxWidth],
  )

  const reset = useCallback(() => {
    setPreferred(null)
    safeRemoveItem(storageKey)
  }, [storageKey])

  return { width, setWidth, commit, reset }
}

export function SidePaneResizeHandle({
  width,
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  onReset,
}: {
  width: number
  minWidth: number
  maxWidth: number
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const latestWidthRef = useRef(width)
  const stopDrag = useRef<(() => void) | null>(null)
  latestWidthRef.current = width

  useEffect(() => () => stopDrag.current?.(), [])

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      setDragging(true)

      // A canvas iframe under the cursor swallows pointermove. A fixed
      // overlay above every iframe keeps the drag alive across the seam.
      const overlay = document.createElement('div')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;cursor:col-resize;background:transparent;'
      document.body.appendChild(overlay)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onPointerMove = (ev: PointerEvent) => {
        const next = clampSidePaneWidth(startWidth + (startX - ev.clientX), minWidth, maxWidth)
        latestWidthRef.current = next
        onResize(next)
      }
      const onPointerUp = () => {
        stopDrag.current = null
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        overlay.remove()
        setDragging(false)
        onResizeEnd(latestWidthRef.current)
      }
      stopDrag.current = onPointerUp
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
    },
    [width, minWidth, maxWidth, onResize, onResizeEnd],
  )

  if (Platform.OS !== 'web') return null

  const active = dragging || hovered
  return (
    <View
      accessibilityLabel="Resize panel"
      // @ts-expect-error web-only event handlers
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: 12,
        cursor: 'col-resize' as const,
        zIndex: 21,
      }}
    >
      <View
        className={cn('absolute bottom-0 top-0 transition-all duration-150', active ? 'bg-primary/40' : 'bg-transparent')}
        style={{ left: 0, width: active ? 3 : 1 }}
      />
    </View>
  )
}
