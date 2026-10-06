// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's colour as a soft glow from the top of a screen, drifting slowly
 * and fading into the background. Render it as the first child of a screen;
 * it never takes touches. The motion pauses while the screen is not in focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useFocusEffect } from 'expo-router'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { glowHex } from '../../lib/agent-glow'

function useFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )
  return focused
}

function useDrift(running: boolean, durationMs: number, distance: number) {
  const value = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!running) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: durationMs, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(value, { toValue: 0, duration: durationMs, easing: Easing.inOut(Easing.sin), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [running, durationMs, value])
  return value.interpolate({ inputRange: [0, 1], outputRange: [-distance, distance] })
}

function Glow({ id, color, size, opacity }: { id: string; color: string; size: number; opacity: number }) {
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={size} height={size} fill={`url(#${id})`} />
    </Svg>
  )
}

export function AgentBackdrop({ color, height = 380 }: { color?: string | null; height?: number }) {
  const { width } = useWindowDimensions()
  const focused = useFocused()
  const hex = glowHex(color)
  const size = Math.max(width, 320) * 1.3
  const dx = useDrift(focused, 9000, 40)
  const dy = useDrift(focused, 11000, 26)
  const dx2 = useDrift(focused, 13000, 50)

  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { height, overflow: 'hidden' }]}>
      <Animated.View style={{ position: 'absolute', top: -size * 0.55, left: -size * 0.15, transform: [{ translateX: dx }, { translateY: dy }] }}>
        <Glow id="agent-glow-a" color={hex} size={size} opacity={0.42} />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: -size * 0.7, right: -size * 0.45, transform: [{ translateX: dx2 }] }}>
        <Glow id="agent-glow-b" color={hex} size={size * 0.8} opacity={0.28} />
      </Animated.View>
    </View>
  )
}
