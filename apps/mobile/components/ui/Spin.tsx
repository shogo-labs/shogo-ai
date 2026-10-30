// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Continuous-motion wrappers for native. NativeWind's `animate-spin` and
 * `animate-pulse` classes are driven by Reanimated, which this app doesn't
 * ship, so on iOS/Android they render as a frozen icon. These run the same
 * motion on the native thread with core `Animated`; on web they render their
 * children untouched and the CSS classes keep doing the work.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, Platform } from 'react-native'

const isWeb = Platform.OS === 'web'

interface SpinProps {
  /** Spin while true; at rest the child returns to its upright pose. */
  active?: boolean
  /** One full turn, in milliseconds. */
  duration?: number
  children: ReactNode
}

/** Rotates its child continuously, e.g. a `Loader2` or `RefreshCw` icon. */
export function Spin({ active = true, duration = 900, children }: SpinProps) {
  const turn = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (isWeb || !active) return
    turn.setValue(0)
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [active, duration, turn])

  if (isWeb) return <>{children}</>
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>
}

interface PulseProps {
  active?: boolean
  /** One full fade out and back, in milliseconds. */
  duration?: number
  /** Opacity at the dimmest point. */
  min?: number
  children: ReactNode
}

/** Fades its child in and out, e.g. a live-status dot. */
export function Pulse({ active = true, duration = 1600, min = 0.35, children }: PulseProps) {
  const opacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (isWeb || !active) return
    const half = duration / 2
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: min,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => {
      loop.stop()
      opacity.setValue(1)
    }
  }, [active, duration, min, opacity])

  if (isWeb) return <>{children}</>
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}
