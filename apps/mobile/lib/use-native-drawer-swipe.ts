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
export const NATIVE_DRAWER_SHEET_SHADOW_COLOR = '#000000'
export const NATIVE_DRAWER_SHEET_SHADOW_OPACITY = 0.12
export const NATIVE_DRAWER_SHEET_SHADOW_RADIUS = 8
export const NATIVE_DRAWER_SHEET_ELEVATION = 4
export const NATIVE_DRAWER_SHEET_SHADOW_OFFSET = { width: -1, height: 0 } as const
export const NATIVE_DRAWER_MIN_TOP_INSET = 56
export const NATIVE_DRAWER_MIN_SIDE_INSET = 4
export const NATIVE_DRAWER_MIN_FOOTER_INSET = 12

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

export function nativeDrawerTopInset(safeTop: number): number {
  return Math.max(safeTop, NATIVE_DRAWER_MIN_TOP_INSET)
}

export function nativeDrawerSideInset(safeLeft: number): number {
  return Math.max(safeLeft, NATIVE_DRAWER_MIN_SIDE_INSET)
}

export function nativeDrawerFooterInset(safeBottom: number): number {
  return Math.max(safeBottom, NATIVE_DRAWER_MIN_FOOTER_INSET)
}

export function nativeDrawerUnderlayStyle(drawerWidth: number) {
  return {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: drawerWidth,
    zIndex: 0,
    backgroundColor: NATIVE_DRAWER_UNDERLAY_BACKGROUND,
  }
}

/** Shared foreground-sheet motion used by the app and admin native drawers. */
export function useNativeDrawerSheetStyle(
  drawerProgress: Animated.Value,
  drawerWidth: number,
) {
  const sheetRadius = useMemo(
    () =>
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, NATIVE_DRAWER_SHEET_RADIUS],
      }),
    [drawerProgress],
  )
  const sheetShadow = useMemo(
    () =>
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, NATIVE_DRAWER_SHEET_SHADOW_OPACITY],
      }),
    [drawerProgress],
  )
  const sheetTranslateX = useMemo(
    () =>
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, drawerWidth],
      }),
    [drawerProgress, drawerWidth],
  )
  const sheetElevation = useMemo(
    () =>
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, NATIVE_DRAWER_SHEET_ELEVATION],
      }),
    [drawerProgress],
  )
  const sheetStyle = useMemo(
    () => ({
      transform: [{ translateX: sheetTranslateX }],
      borderTopLeftRadius: sheetRadius,
      borderBottomLeftRadius: sheetRadius,
      shadowColor: NATIVE_DRAWER_SHEET_SHADOW_COLOR,
      shadowOffset: NATIVE_DRAWER_SHEET_SHADOW_OFFSET,
      shadowOpacity: sheetShadow,
      shadowRadius: NATIVE_DRAWER_SHEET_SHADOW_RADIUS,
      elevation: sheetElevation,
    }),
    [sheetElevation, sheetRadius, sheetShadow, sheetTranslateX],
  )
  const sheetClipStyle = useMemo(
    () => ({
      flex: 1 as const,
      overflow: 'hidden' as const,
      borderTopLeftRadius: sheetRadius,
      borderBottomLeftRadius: sheetRadius,
    }),
    [sheetRadius],
  )
  return { sheetStyle, sheetClipStyle }
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
