// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CursorBlink Component (React Native)
 *
 * Blinking cursor indicator for active streaming.
 * Uses React Native's built-in Animated API for the blink animation.
 */

import { View, Animated } from "react-native"
import { useEffect, useRef } from "react"
import { cn } from "@shogo/shared-ui/primitives"

export interface CursorBlinkProps {
  isVisible: boolean
  className?: string
}

export function CursorBlink({ isVisible, className }: CursorBlinkProps) {
  const opacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (isVisible) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      )
      animation.start()
      return () => animation.stop()
    } else {
      opacity.setValue(1)
    }
  }, [isVisible])

  if (!isVisible) {
    return null
  }

  return (
    <Animated.View
      className={cn("w-[2px] h-4 ml-0.5 bg-primary", className)}
      style={{ opacity }}
      accessibilityElementsHidden
    />
  )
}

export default CursorBlink
