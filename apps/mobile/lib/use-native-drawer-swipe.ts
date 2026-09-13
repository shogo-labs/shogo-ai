// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native two-layer drawer: the sidebar sits underneath; the current screen
 * is a foreground sheet the user drags to the right. One progress value
 * (0 closed → 1 open) drives sheet translation and left-corner radius.
 *
 * Motion and clip are separate layers. iOS flashes when transform, radius,
 * overflow, and fill animate on the same view — especially around SVG/home
 * content. The outer layer only translates and casts a shadow; the inner
 * layer clips the rounded left corners. Matching closed/open canvases stay
 * a static fill so swipe frames do not lerp a second color.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Keyboard,
  PanResponder,
  type GestureResponderHandlers,
} from 'react-native'
import { hexToRgbChannels, isNativePlatform, nativePhoneCanvas } from './native-phone-layout'

const OPEN_RATIO = 0.32
const OPEN_VELOCITY = 0.7
/** Closed sheet: finger must travel this far right before the drawer claims the gesture. */
const OPEN_CAPTURE_DX = 6
/** Open sheet: finger must travel this far left before the drawer claims the gesture. */
const CLOSE_CAPTURE_DX = -8
/** Left-corner radius of the moving foreground sheet when fully open (pt). */
export const NATIVE_DRAWER_SHEET_RADIUS = 52
/** Target sidebar width as a fraction of the viewport. */
export const NATIVE_DRAWER_WIDTH_RATIO = 0.75
export const NATIVE_DRAWER_SHEET_SHADOW_COLOR = '#000000'
export const NATIVE_DRAWER_SHEET_SHADOW_OPACITY = 0.12
export const NATIVE_DRAWER_SHEET_SHADOW_RADIUS = 8
export const NATIVE_DRAWER_SHEET_ELEVATION = 4
export const NATIVE_DRAWER_SHEET_SHADOW_OFFSET = { width: -1, height: 0 } as const
/** Opt-in open-sheet fill. Callers that omit `openCanvas` keep the closed canvas. */
export const NATIVE_DRAWER_SHEET_OPEN_CANVAS = '#3A3A3C'
export const NATIVE_DRAWER_MIN_TOP_INSET = 56
export const NATIVE_DRAWER_MIN_SIDE_INSET = 4
export const NATIVE_DRAWER_MIN_FOOTER_INSET = 12
/** Rasterize the moving sheet once progress leaves rest, not on every tick. */
export const NATIVE_DRAWER_COMPOSITING_EPSILON = 0.001

const SETTLE_SPRING = {
  stiffness: 340,
  damping: 38,
  mass: 0.72,
  overshootClamping: true,
  restDisplacementThreshold: 0.002,
  restSpeedThreshold: 0.02,
  // Radius still interpolates on the inner clip, so the spring stays on JS.
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

function nativeDrawerOpenCanvas(
  isDark: boolean,
  closed: string,
  openCanvas?: string,
): string {
  if (!isDark) return nativePhoneCanvas(false)
  return openCanvas ?? closed
}

export function nativeDrawerSheetEnds(
  isDark: boolean,
  closedCanvas?: string,
  openCanvas?: string,
): { closed: string; open: string } {
  if (!isDark) {
    const fill = nativePhoneCanvas(false)
    return { closed: fill, open: fill }
  }
  const closed = closedCanvas ?? nativePhoneCanvas(true)
  return { closed, open: nativeDrawerOpenCanvas(true, closed, openCanvas) }
}

/** Canvas of the moving foreground sheet at a given 0–1 drawer progress. */
export function nativeDrawerSheetCanvas(
  progress: number,
  isDark: boolean,
  closedCanvas?: string,
  openCanvas?: string,
): string {
  const { closed, open } = nativeDrawerSheetEnds(isDark, closedCanvas, openCanvas)
  const t = Math.min(1, Math.max(0, progress))
  if (t === 0 || closed === open) return closed
  if (t === 1) return open
  const [r0, g0, b0] = hexToRgbChannels(closed)
  const [r1, g1, b1] = hexToRgbChannels(open)
  return rgbToHex(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t)
}

/** Outer sheet: slide + shadow. No radius or overflow — those clip on iOS. */
export function nativeDrawerOuterSheetStyle(
  translateX: number | Animated.AnimatedInterpolation<number>,
  shadowOpacity: number | Animated.AnimatedInterpolation<number>,
  elevation: number | Animated.AnimatedInterpolation<number>,
) {
  return {
    transform: [{ translateX }],
    shadowColor: NATIVE_DRAWER_SHEET_SHADOW_COLOR,
    shadowOffset: NATIVE_DRAWER_SHEET_SHADOW_OFFSET,
    shadowOpacity,
    shadowRadius: NATIVE_DRAWER_SHEET_SHADOW_RADIUS,
    elevation,
  }
}

/** Inner sheet: static fill + left-corner clip. No transform. */
export function nativeDrawerClipSheetStyle(
  radius: number | Animated.AnimatedInterpolation<number>,
  fill: string | Animated.AnimatedInterpolation<string | number>,
) {
  return {
    flex: 1 as const,
    overflow: 'hidden' as const,
    backgroundColor: fill,
    borderTopLeftRadius: radius,
    borderBottomLeftRadius: radius,
  }
}

/** Shared foreground-sheet motion used by the app and admin native drawers. */
export function useNativeDrawerSheetStyle(
  drawerProgress: Animated.Value,
  drawerWidth: number,
  isDark = true,
  closedCanvas?: string,
  openCanvas?: string,
) {
  const { closed, open } = nativeDrawerSheetEnds(isDark, closedCanvas, openCanvas)
  const staticFill = closed === open ? closed : null
  const sheetCanvas = useMemo(
    () =>
      staticFill ??
      drawerProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [closed, open],
      }),
    [closed, drawerProgress, open, staticFill],
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
    () => nativeDrawerOuterSheetStyle(sheetTranslateX, sheetShadow, sheetElevation),
    [sheetElevation, sheetShadow, sheetTranslateX],
  )
  const sheetClipStyle = useMemo(
    () => nativeDrawerClipSheetStyle(sheetRadius, sheetCanvas),
    [sheetCanvas, sheetRadius],
  )
  return { sheetStyle, sheetClipStyle, sheetFill: closed }
}

export function nativeDrawerProgressFromDelta(start: number, dx: number, width: number): number {
  return Math.min(1, Math.max(0, start + dx / Math.max(1, width)))
}

/**
 * Whether a move should steal the gesture for the sheet drawer.
 * Opening is a right-swipe from anywhere on the sheet (not a left-edge hit
 * target). Closing is a left-swipe. Vertical-dominant moves stay with children.
 */
export function nativeDrawerShouldCaptureSwipe({
  enabled,
  isOpen,
  dx,
  dy,
}: {
  enabled: boolean
  isOpen: boolean
  dx: number
  dy: number
}): boolean {
  if (!enabled) return false
  if (Math.abs(dx) <= Math.abs(dy)) return false
  if (isOpen) return dx < CLOSE_CAPTURE_DX
  return dx > OPEN_CAPTURE_DX
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

/** Native sidebar opening should drop the keyboard so it cannot sit on the drawer. */
export function nativeDrawerShouldDismissKeyboard(opening: boolean, native = isNativePlatform()): boolean {
  return native && opening
}

export function dismissKeyboardForNativeDrawer(opening: boolean): void {
  if (nativeDrawerShouldDismissKeyboard(opening)) Keyboard.dismiss()
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
  openCanvas,
}: {
  windowWidth: number
  isDark: boolean
  swipeEnabled: boolean
  overlayOpenWithoutSnap?: boolean
  /** Dark closed-sheet fill. Home passes OLED black; other screens omit this. */
  closedCanvas?: string
  /** Dark open-sheet fill. Omit to keep the closed canvas for the whole swipe. */
  openCanvas?: string
}) {
  const drawerProgress = useRef(new Animated.Value(0)).current
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sheetCompositing, setSheetCompositing] = useState(false)
  const drawerWidth = nativeDrawerPanelWidth(windowWidth)
  const sheetProgressRef = useRef(0)

  useEffect(() => {
    const id = drawerProgress.addListener(({ value }) => {
      sheetProgressRef.current = value
      const active = value > NATIVE_DRAWER_COMPOSITING_EPSILON
      setSheetCompositing((prev) => (prev === active ? prev : active))
    })
    return () => drawerProgress.removeListener(id)
  }, [drawerProgress])

  const resetDrawer = useCallback(() => {
    drawerProgress.setValue(0)
    setDrawerOpen(false)
    setSheetCompositing(false)
  }, [drawerProgress])

  const openDrawer = useCallback(() => {
    dismissKeyboardForNativeDrawer(true)
    snapNativeDrawer(drawerProgress, true)
    setDrawerOpen(true)
  }, [drawerProgress])

  const closeDrawer = useCallback(() => {
    snapNativeDrawer(drawerProgress, false, (open) => {
      if (!open) resetDrawer()
    })
  }, [drawerProgress, resetDrawer])

  const toggleDrawer = useCallback(() => {
    if (drawerOpen) closeDrawer()
    else if (overlayOpenWithoutSnap) {
      dismissKeyboardForNativeDrawer(true)
      setDrawerOpen(true)
    } else openDrawer()
  }, [closeDrawer, drawerOpen, openDrawer, overlayOpenWithoutSnap])

  const sheetSwipeHandlers = useNativeDrawerSheetSwipe({
    enabled: swipeEnabled,
    drawerWidth,
    drawerProgress,
    isOpen: drawerOpen,
    onOpenChange: setDrawerOpen,
    currentProgressRef: sheetProgressRef,
  })
  const { sheetStyle, sheetClipStyle, sheetFill } = useNativeDrawerSheetStyle(
    drawerProgress,
    drawerWidth,
    isDark,
    closedCanvas,
    openCanvas,
  )
  const underlayStyle = useMemo(
    () => nativeDrawerUnderlayStyle(drawerWidth, isDark),
    [drawerWidth, isDark],
  )

  return {
    drawerOpen,
    drawerWidth,
    drawerProgress,
    sheetSwipeHandlers,
    sheetStyle,
    sheetClipStyle,
    sheetFill,
    sheetCompositing,
    underlayStyle,
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
  currentProgressRef,
}: {
  enabled: boolean
  drawerWidth: number
  drawerProgress: Animated.Value
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** Shared with the drawer controller so progress is observed once. */
  currentProgressRef: { current: number }
}): GestureResponderHandlers | undefined {
  const enabledRef = useRef(enabled)
  const isOpenRef = useRef(isOpen)
  const widthRef = useRef(drawerWidth)
  const onOpenChangeRef = useRef(onOpenChange)
  const startProgressRef = useRef(0)
  const progressRef = useRef(currentProgressRef)
  enabledRef.current = enabled
  isOpenRef.current = isOpen
  widthRef.current = drawerWidth
  onOpenChangeRef.current = onOpenChange
  progressRef.current = currentProgressRef

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_evt, gesture) =>
          nativeDrawerShouldCaptureSwipe({
            enabled: enabledRef.current,
            isOpen: isOpenRef.current,
            dx: gesture.dx,
            dy: gesture.dy,
          }),
        onPanResponderGrant: () => {
          dismissKeyboardForNativeDrawer(!isOpenRef.current)
          drawerProgress.stopAnimation()
          startProgressRef.current = progressRef.current.current
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
