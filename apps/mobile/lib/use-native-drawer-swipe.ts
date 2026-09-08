// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native two-layer drawer: the sidebar sits underneath; the current screen
 * is a foreground sheet the user drags to the right. One progress value
 * (0 closed → 1 open) drives sheet translation and left-corner radius.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  Animated,
  PanResponder,
  type GestureResponderHandlers,
} from 'react-native'

const EDGE_WIDTH = 28
const OPEN_RATIO = 0.32
const OPEN_VELOCITY = 0.7
/** Left-corner radius of the moving foreground sheet when fully open (pt). */
export const NATIVE_DRAWER_SHEET_RADIUS = 52
/** Sidebar / navigation background. */
export const NATIVE_DRAWER_UNDERLAY_BACKGROUND = '#000000'
/** Target sidebar width as a fraction of the viewport. */
export const NATIVE_DRAWER_WIDTH_RATIO = 0.75

const SETTLE_SPRING = {
  stiffness: 340,
  damping: 38,
  mass: 0.72,
  overshootClamping: true,
  restDisplacementThreshold: 0.002,
  restSpeedThreshold: 0.02,
  // Radius / shadow must stay on the JS thread with translateX.
  useNativeDriver: false,
} as const

export function nativeDrawerPanelWidth(windowWidth: number): number {
  return Math.round(windowWidth * NATIVE_DRAWER_WIDTH_RATIO)
}

export function nativeDrawerProgressFromDelta(start: number, dx: number, width: number): number {
  return Math.min(1, Math.max(0, start + dx / Math.max(1, width)))
}

/**
 * Snap to open or closed. `start` is progress when the finger went down, so a
 * close drag only needs the same ~32% travel as an open drag — not a trip all
 * the way back below 0.32.
 */
export function nativeDrawerShouldSettleOpen(
  progress: number,
  vx: number,
  start = 0,
): boolean {
  if (vx > OPEN_VELOCITY) return true
  if (vx < -OPEN_VELOCITY) return false
  if (start >= 0.5) return progress > 1 - OPEN_RATIO
  return progress > OPEN_RATIO
}

export function snapNativeDrawer(
  drawerProgress: Animated.Value,
  open: boolean,
  onSettled?: (open: boolean) => void,
) {
  Animated.spring(drawerProgress, {
    toValue: open ? 1 : 0,
    ...SETTLE_SPRING,
  }).start(({ finished }) => {
    if (finished) onSettled?.(open)
  })
}

export function useNativeDrawerSheetSwipe({
  enabled,
  drawerWidth,
  drawerProgress,
  isOpen,
  onOpenChange,
}: {
  enabled: boolean
  drawerWidth: number
  drawerProgress: Animated.Value
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}): GestureResponderHandlers | undefined {
  const enabledRef = useRef(enabled)
  const isOpenRef = useRef(isOpen)
  const widthRef = useRef(drawerWidth)
  const onOpenChangeRef = useRef(onOpenChange)
  const startProgressRef = useRef(0)
  const currentProgressRef = useRef(0)
  enabledRef.current = enabled
  isOpenRef.current = isOpen
  widthRef.current = drawerWidth
  onOpenChangeRef.current = onOpenChange

  useEffect(() => {
    const id = drawerProgress.addListener(({ value }) => {
      currentProgressRef.current = value
    })
    return () => drawerProgress.removeListener(id)
  }, [drawerProgress])

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (evt, gesture) => {
          if (!enabledRef.current) return false
          const horizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy)
          if (!horizontal) return false
          if (isOpenRef.current) {
            return gesture.dx < -8
          }
          const startX = evt.nativeEvent.pageX - gesture.dx
          if (startX > EDGE_WIDTH) return false
          return gesture.dx > 6
        },
        onPanResponderGrant: () => {
          drawerProgress.stopAnimation()
          startProgressRef.current = currentProgressRef.current
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_evt, gesture) => {
          drawerProgress.setValue(
            nativeDrawerProgressFromDelta(startProgressRef.current, gesture.dx, widthRef.current),
          )
        },
        onPanResponderRelease: (_evt, gesture) => {
          settleSheet(drawerProgress, startProgressRef.current, gesture.dx, gesture.vx, widthRef.current, onOpenChangeRef.current)
        },
        onPanResponderTerminate: (_evt, gesture) => {
          settleSheet(drawerProgress, startProgressRef.current, gesture.dx, 0, widthRef.current, onOpenChangeRef.current)
        },
      }),
    [drawerProgress],
  )

  if (!enabled) return undefined
  return pan.panHandlers
}

function settleSheet(
  drawerProgress: Animated.Value,
  start: number,
  dx: number,
  vx: number,
  width: number,
  onOpenChange: (open: boolean) => void,
) {
  const progress = nativeDrawerProgressFromDelta(start, dx, width)
  const open = nativeDrawerShouldSettleOpen(progress, vx, start)
  if (open) onOpenChange(true)
  snapNativeDrawer(drawerProgress, open, onOpenChange)
}
