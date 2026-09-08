// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatGPT-style left-edge swipe to open the native app drawer.
 * The drawer tracks the thumb; release snaps open or closed.
 */
import { useMemo, useRef } from 'react'
import {
  Animated,
  Easing,
  PanResponder,
  type GestureResponderHandlers,
} from 'react-native'

const EDGE_WIDTH = 40
const OPEN_RATIO = 0.32
const OPEN_VELOCITY = 0.7

export function nativeDrawerPanelWidth(windowWidth: number): number {
  return Math.min(288, Math.max(264, windowWidth - 48))
}

function snapDrawer(
  drawerProgress: Animated.Value,
  open: boolean,
  onSettled: (open: boolean) => void,
) {
  Animated.timing(drawerProgress, {
    toValue: open ? 1 : 0,
    duration: open ? 200 : 160,
    easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    useNativeDriver: true,
  }).start(({ finished }) => {
    if (finished) onSettled(open)
  })
}

export function useNativeDrawerOpenSwipe({
  enabled,
  drawerWidth,
  drawerProgress,
  isOpen,
  onOpenChange,
  onGestureChange,
}: {
  enabled: boolean
  drawerWidth: number
  drawerProgress: Animated.Value
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onGestureChange?: (active: boolean) => void
}): GestureResponderHandlers | undefined {
  const enabledRef = useRef(enabled)
  const isOpenRef = useRef(isOpen)
  const widthRef = useRef(drawerWidth)
  const onOpenChangeRef = useRef(onOpenChange)
  const onGestureChangeRef = useRef(onGestureChange)
  enabledRef.current = enabled
  isOpenRef.current = isOpen
  widthRef.current = drawerWidth
  onOpenChangeRef.current = onOpenChange
  onGestureChangeRef.current = onGestureChange

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (evt, gesture) => {
          if (!enabledRef.current || isOpenRef.current) return false
          const startX = evt.nativeEvent.pageX - gesture.dx
          if (startX > EDGE_WIDTH) return false
          return gesture.dx > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy)
        },
        onPanResponderGrant: () => {
          drawerProgress.stopAnimation()
          onGestureChangeRef.current?.(true)
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_evt, gesture) => {
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, gesture.dx / width))
          drawerProgress.setValue(progress)
        },
        onPanResponderRelease: (_evt, gesture) => {
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, gesture.dx / width))
          const open = progress > OPEN_RATIO || gesture.vx > OPEN_VELOCITY
          snapDrawer(drawerProgress, open, (next) => {
            onGestureChangeRef.current?.(false)
            onOpenChangeRef.current(next)
          })
        },
        onPanResponderTerminate: (_evt, gesture) => {
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, gesture.dx / width))
          const open = progress > OPEN_RATIO
          snapDrawer(drawerProgress, open, (next) => {
            onGestureChangeRef.current?.(false)
            onOpenChangeRef.current(next)
          })
        },
      }),
    [drawerProgress],
  )

  if (!enabled) return undefined
  return pan.panHandlers
}

export function useNativeDrawerCloseSwipe({
  enabled,
  drawerWidth,
  drawerProgress,
  onClose,
  onCancelClose,
  closeOnTap = false,
}: {
  enabled: boolean
  drawerWidth: number
  drawerProgress: Animated.Value
  onClose: () => void
  onCancelClose: () => void
  closeOnTap?: boolean
}): GestureResponderHandlers | undefined {
  const enabledRef = useRef(enabled)
  const widthRef = useRef(drawerWidth)
  const onCloseRef = useRef(onClose)
  const onCancelCloseRef = useRef(onCancelClose)
  const closeOnTapRef = useRef(closeOnTap)
  enabledRef.current = enabled
  widthRef.current = drawerWidth
  onCloseRef.current = onClose
  onCancelCloseRef.current = onCancelClose
  closeOnTapRef.current = closeOnTap

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !!closeOnTapRef.current && enabledRef.current,
        onMoveShouldSetPanResponder: (_evt, gesture) => {
          if (!enabledRef.current) return false
          return gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15
        },
        onPanResponderGrant: () => {
          drawerProgress.stopAnimation()
        },
        onPanResponderMove: (_evt, gesture) => {
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, 1 + gesture.dx / width))
          drawerProgress.setValue(progress)
        },
        onPanResponderRelease: (_evt, gesture) => {
          if (closeOnTapRef.current && Math.abs(gesture.dx) < 6 && Math.abs(gesture.dy) < 6) {
            onCloseRef.current()
            return
          }
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, 1 + gesture.dx / width))
          const close = progress < 1 - OPEN_RATIO || gesture.vx < -OPEN_VELOCITY
          if (close) onCloseRef.current()
          else onCancelCloseRef.current()
        },
        onPanResponderTerminate: (_evt, gesture) => {
          const width = Math.max(1, widthRef.current)
          const progress = Math.min(1, Math.max(0, 1 + gesture.dx / width))
          if (progress < 1 - OPEN_RATIO) onCloseRef.current()
          else onCancelCloseRef.current()
        },
      }),
    [drawerProgress],
  )

  if (!enabled) return undefined
  return pan.panHandlers
}
