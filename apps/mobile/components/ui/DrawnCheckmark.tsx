// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A ring that draws itself, then a tick: the "done" mark for an action that
 * reached the agent. `tone` picks green for approved, red for denied (a cross).
 */
import { useEffect, useRef } from 'react'
import { Animated, Easing } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const AnimatedPath = Animated.createAnimatedComponent(Path)

const COLORS = { success: '#22c55e', danger: '#ef4444' } as const

export function DrawnCheckmark({ size = 34, tone = 'success' }: { size?: number; tone?: keyof typeof COLORS }) {
  const ring = useRef(new Animated.Value(0)).current
  const mark = useRef(new Animated.Value(0)).current
  const color = COLORS[tone]
  const radius = 20
  const circumference = 2 * Math.PI * radius
  const markLength = 40

  useEffect(() => {
    Animated.sequence([
      Animated.timing(ring, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.timing(mark, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start()
  }, [ring, mark])

  const ringOffset = ring.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] })
  const markOffset = mark.interpolate({ inputRange: [0, 1], outputRange: [markLength, 0] })
  const d = tone === 'success' ? 'M14 25 L21 32 L34 17' : 'M17 17 L31 31 M31 17 L17 31'

  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <AnimatedCircle
        cx="24"
        cy="24"
        r={radius}
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={ringOffset}
        rotation={-90}
        origin="24, 24"
      />
      <AnimatedPath
        d={d}
        stroke={color}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        strokeDasharray={`${markLength} ${markLength}`}
        strokeDashoffset={markOffset}
      />
    </Svg>
  )
}