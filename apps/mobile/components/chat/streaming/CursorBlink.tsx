/**
 * CursorBlink Component (React Native)
 *
 * Blinking cursor indicator for active streaming.
 * Uses react-native-reanimated for the blink animation.
 */

import { View } from "react-native"
import { useEffect } from "react"
import { cn } from "@shogo/shared-ui/primitives"
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface CursorBlinkProps {
  isVisible: boolean
  className?: string
}

export function CursorBlink({ isVisible, className }: CursorBlinkProps) {
  const prefersReducedMotion = useReducedMotion()
  const opacity = useSharedValue(1)

  useEffect(() => {
    if (isVisible && !prefersReducedMotion) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 500 }),
          withTiming(1, { duration: 500 })
        ),
        -1,
        false
      )
    } else {
      cancelAnimation(opacity)
      opacity.value = 1
    }

    return () => {
      cancelAnimation(opacity)
    }
  }, [isVisible, prefersReducedMotion])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  if (!isVisible) {
    return null
  }

  return (
    <Animated.View
      className={cn("w-[2px] h-4 ml-0.5 bg-blue-400", className)}
      style={animatedStyle}
      accessibilityElementsHidden
    />
  )
}

export default CursorBlink
