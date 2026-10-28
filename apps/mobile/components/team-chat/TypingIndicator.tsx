// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "Ana is typing" line above the composer. The label is plain text and the
 * three dots pulse in turn beside it, which is what makes the line read as live
 * rather than as a caption stuck to the input. Reduced-motion users get the
 * same row with the dots held still.
 */
import { useEffect, useRef } from 'react'
import { Animated, Easing, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useReducedMotion } from '../../hooks/useReducedMotion'

/** One dot's rise-and-fall. Long enough to notice, short enough not to nag. */
const PULSE_MS = 320
/** Each dot starts this much after the one before it. */
const STAGGER_MS = 150
const DIMMED = 0.28
const LIT = 1

function TypingDot({ index, reduced }: { index: number; reduced: boolean }) {
  const opacity = useRef(new Animated.Value(DIMMED)).current

  useEffect(() => {
    if (reduced) {
      opacity.setValue(DIMMED)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: LIT,
          duration: PULSE_MS,
          delay: index * STAGGER_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: DIMMED,
          duration: PULSE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        // Hold while the other two take their turn, so the cycle reads left to right.
        Animated.timing(opacity, {
          toValue: DIMMED,
          duration: (2 - index) * STAGGER_MS,
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [index, opacity, reduced])

  // Opacity rides the animated wrapper only; the dot keeps its colour in className
  // so NativeWind css-interop still styles it.
  return (
    <Animated.View style={{ opacity }} testID={`typing-dot-${index}`}>
      <View className="h-1 w-1 rounded-full bg-muted-foreground" />
    </Animated.View>
  )
}

/**
 * `label` is the sentence without its ellipsis (see `typingLabelText`); the dots
 * are drawn here. `spoken` is the full sentence, which is what a screen reader
 * announces — the dots are decoration and are hidden from it.
 */
export function TypingIndicator({
  label,
  spoken,
  className,
  testID = 'typing-indicator',
}: {
  label: string
  spoken?: string
  className?: string
  testID?: string
}) {
  const reduced = useReducedMotion()
  return (
    <View
      accessible
      accessibilityLabel={spoken ?? `${label}…`}
      accessibilityLiveRegion="polite"
      testID={testID}
      className={cn('flex-row items-center gap-1.5', className)}
    >
      <Text className="text-[13px] text-muted-foreground">{label}</Text>
      <View className="flex-row items-center gap-1" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <TypingDot index={0} reduced={reduced} />
        <TypingDot index={1} reduced={reduced} />
        <TypingDot index={2} reduced={reduced} />
      </View>
    </View>
  )
}
