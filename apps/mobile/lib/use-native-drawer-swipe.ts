// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native two-layer drawer: the sidebar sits underneath; the current screen
 * is a foreground sheet the user drags to the right. One progress value
 * (0 closed → 1 open) drives sheet translation, left-corner radius, and
 * (dark theme) the sheet canvas from closed black/charcoal to the lifted grey.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  PanResponder,
  type GestureResponderHandlers,
} from 'react-native'
import { hexToRgbChannels, nativePhoneCanvas } from './native-phone-layout'

const EDGE_WIDTH = 28
const OPEN_RATIO = 0.32
const OPEN_VELOCITY = 0.7
/** Left-corner radius of the moving foreground sheet when fully open (pt). */
export const NATIVE_DRAWER_SHEET_RADIUS = 52
/** Target sidebar width as a fraction of the viewport. */
export const NATIVE_DRAWER_WIDTH_RATIO = 0.75
export const NATIVE_DRAWER_SHEET_SHADOW_COLOR = '#000000'
export const NATIVE_DRAWER_SHEET_SHADOW_OPACITY = 0.12
export const NATIVE_DRAWER_SHEET_SHADOW_RADIUS = 8
export const NATIVE_DRAWER_SHEET_ELEVATION = 4
export const NATIVE_DRAWER_SHEET_SHADOW_OFFSET = { width: -1, height: 0 } as const
/**
 * Dark ChatGPT sheet: closed screens are OLED black (home uses charcoal
 * via `closedCanvas`); as the sidebar opens the moving foreground lifts
 * to this medium grey at the same progress. Light theme does not change.
 */
export const NATIVE_DRAWER_SHEET_OPEN_CANVAS = '#3A3A3C'
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

export function nativeDrawerUnderlayStyle(drawerWidth: number, isDark: boolean) {
  return {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: drawerWidth,
    zIndex: 0,
    backgroundColor: nativePhoneCanvas(isDark),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (c: number) => Math.round(c).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** Canvas of the moving foreground sheet at a given 0–1 drawer progress. */
export function nativeDrawerSheetCanvas(
  progress: number,
  isDark: boolean,
  closedCanvas?: string,
): string {
  if (!isDark) return nativePhoneCanvas(false)
  const closed = closedCanvas ?? nativePhoneCanvas(true)
  const t = Math.min(1, Math.max(0, progress))
  if (t === 0) return closed
  if (t === 1) return NATIVE_DRAWER_SHEET_OPEN_CANVAS
  const [r0, g0, b0] = hexToRgbChannels(closed)
  const [r1, g1, b1] = hexToRgbChannels(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
  return rgbToHex(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t)
}

/** Shared foreground-sheet motion used by the app and admin native drawers. */
export function useNativeDrawerSheetStyle(
  drawerProgress: Animated.Value,
  drawerWidth: number,
  isDark = true,
  closedCanvas?: string,
) {
  const closed = closedCanvas ?? (isDark ? nativePhoneCanvas(true) : nativePhoneCanvas(false))
  const sheetCanvas = useMemo(
    () =>
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: isDark
          ? [closed, NATIVE_DRAWER_SHEET_OPEN_CANVAS]
          : [nativePhoneCanvas(false), nativePhoneCanvas(false)],
      }),
    [closed, drawerProgress, isDark],
  )
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
      backgroundColor: sheetCanvas,
      shadowColor: NATIVE_DRAWER_SHEET_SHADOW_COLOR,
      shadowOffset: NATIVE_DRAWER_SHEET_SHADOW_OFFSET,
      shadowOpacity: sheetShadow,
      shadowRadius: NATIVE_DRAWER_SHEET_SHADOW_RADIUS,
      elevation: sheetElevation,
    }),
    [sheetCanvas, sheetElevation, sheetRadius, sheetShadow, sheetTranslateX],
  )
  const sheetClipStyle = useMemo(
    () => ({
      flex: 1 as const,
      overflow: 'hidden' as const,
      backgroundColor: sheetCanvas,
      borderTopLeftRadius: sheetRadius,
      borderBottomLeftRadius: sheetRadius,
    }),
    [sheetCanvas, sheetRadius],
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

/**
 * Shared sheet-drawer controller for the app and admin shells.
 * `overlayOpenWithoutSnap` is the narrow-web overlay path (admin): toggle
 * opens without springing the sheet.
 */
export function useNativeSheetDrawer({
  windowWidth,
  isDark,
  swipeEnabled,
  overlayOpenWithoutSnap = false,
  closedCanvas,
}: {
  windowWidth: number
  isDark: boolean
  swipeEnabled: boolean
  overlayOpenWithoutSnap?: boolean
  /** Dark closed-sheet fill. Home passes charcoal; other screens omit this. */
  closedCanvas?: string
}) {
  const drawerProgress = useRef(new Animated.Value(0)).current
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerWidth = nativeDrawerPanelWidth(windowWidth)

  const resetDrawer = useCallback(() => {
    drawerProgress.setValue(0)
    setDrawerOpen(false)
  }, [drawerProgress])

  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
    snapNativeDrawer(drawerProgress, true)
  }, [drawerProgress])

  const closeDrawer = useCallback(() => {
    snapNativeDrawer(drawerProgress, false, (open) => {
      if (!open) resetDrawer()
    })
  }, [drawerProgress, resetDrawer])

  const toggleDrawer = useCallback(() => {
    if (drawerOpen) closeDrawer()
    else if (overlayOpenWithoutSnap) setDrawerOpen(true)
    else openDrawer()
  }, [closeDrawer, drawerOpen, openDrawer, overlayOpenWithoutSnap])

  const sheetSwipeHandlers = useNativeDrawerSheetSwipe({
    enabled: swipeEnabled,
    drawerWidth,
    drawerProgress,
    isOpen: drawerOpen,
    onOpenChange: setDrawerOpen,
  })
  const { sheetStyle, sheetClipStyle } = useNativeDrawerSheetStyle(
    drawerProgress,
    drawerWidth,
    isDark,
    closedCanvas,
  )

  return {
    drawerOpen,
    drawerWidth,
    drawerProgress,
    sheetSwipeHandlers,
    sheetStyle,
    sheetClipStyle,
    underlayStyle: nativeDrawerUnderlayStyle(drawerWidth, isDark),
    openDrawer,
    closeDrawer,
    toggleDrawer,
    resetDrawer,
  }
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
