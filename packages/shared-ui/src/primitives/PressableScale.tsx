// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/** Scale a pressed control settles at: a small, quick dip, not a squash. */
export const PRESSED_SCALE = 0.97

// SwiftUI `.snappy` (response 0.5s, damping ratio 0.85) with a shorter
// response, so the dip lands within a frame or two of the finger going down
// and the release bounces back without lingering.
const PRESS_SPRING = { stiffness: 520, damping: 34, mass: 1 } as const

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => {
        if (alive) setReduce(!!enabled)
      })
      .catch(() => {})
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduce)
    return () => {
      alive = false
      subscription?.remove?.()
    }
  }, [])
  return reduce
}

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  className?: string
  style?: StyleProp<ViewStyle>
  /** Scale while pressed. Defaults to {@link PRESSED_SCALE}. */
  scaleTo?: number
  /**
   * Called on press-down, on the same frame as the visual change. Pass a haptic
   * tick here for meaningful controls; it is not tied to any haptics library so
   * this package stays platform-agnostic.
   */
  feedback?: () => void
}

/**
 * A drop-in `Pressable` that dips to a slightly smaller scale the moment a
 * finger lands and springs back on release, so a tap is felt on press-down
 * rather than on release. Pass `feedback` for a haptic tick. Respects Reduce
 * Motion (no scale change). `style` must be a plain style, not a function.
 */
export const PressableScale = forwardRef<View, PressableScaleProps>(function PressableScale(
  { scaleTo = PRESSED_SCALE, feedback, onPressIn, onPressOut, style, disabled, ...rest },
  ref,
) {
  const scale = useRef(new Animated.Value(1)).current
  const reduceMotion = useReduceMotion()

  const spring = useCallback(
    (toValue: number) => {
      if (reduceMotion) return
      Animated.spring(scale, {
        toValue,
        ...PRESS_SPRING,
        useNativeDriver: Platform.OS !== 'web',
      }).start()
    },
    [reduceMotion, scale],
  )

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (!disabled) {
        spring(scaleTo)
        feedback?.()
      }
      onPressIn?.(event)
    },
    [disabled, feedback, onPressIn, scaleTo, spring],
  )

  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      spring(1)
      onPressOut?.(event)
    },
    [onPressOut, spring],
  )

  // The press dip is a touch affordance; web and desktop keep a plain Pressable.
  if (Platform.OS === 'web') {
    return <Pressable ref={ref} {...rest} disabled={disabled} onPressIn={onPressIn} onPressOut={onPressOut} style={style} />
  }

  return (
    <AnimatedPressable
      ref={ref}
      {...rest}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, { transform: [{ scale }] }]}
    />
  )
})
