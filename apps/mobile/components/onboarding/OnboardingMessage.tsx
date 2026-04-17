// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useRef, useState } from 'react'
import { View, Text, Animated } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

const CHAR_DELAY_MS = 18
const MIN_STREAM_DURATION_MS = 300

interface OnboardingMessageProps {
  text: string
  isActive: boolean
  onStreamComplete?: () => void
  children?: React.ReactNode
}

export function OnboardingMessage({
  text,
  isActive,
  onStreamComplete,
  children,
}: OnboardingMessageProps) {
  const [displayedText, setDisplayedText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamDone, setStreamDone] = useState(false)
  const widgetOpacity = useRef(new Animated.Value(0)).current
  const widgetTranslateY = useRef(new Animated.Value(24)).current
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const charIndexRef = useRef(0)

  useEffect(() => {
    if (!isActive || streamDone) return

    setIsStreaming(true)
    charIndexRef.current = 0
    setDisplayedText('')

    intervalRef.current = setInterval(() => {
      charIndexRef.current++
      if (charIndexRef.current >= text.length) {
        setDisplayedText(text)
        setIsStreaming(false)
        setStreamDone(true)
        if (intervalRef.current) clearInterval(intervalRef.current)
        onStreamComplete?.()
      } else {
        setDisplayedText(text.slice(0, charIndexRef.current))
      }
    }, CHAR_DELAY_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isActive])

  useEffect(() => {
    if (streamDone && children) {
      Animated.parallel([
        Animated.timing(widgetOpacity, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(widgetTranslateY, {
          toValue: 0,
          duration: 900,
          useNativeDriver: true,
        }),
      ]).start()
    }
  }, [streamDone, children])

  if (!isActive && !streamDone) return null

  return (
    <View className="gap-2">
      <View className="flex-row items-start gap-2">
        <View className="flex-1 pt-1">
          <Text className="text-base text-foreground leading-6">
            {displayedText}
            {isStreaming && (
              <Text className="text-primary">|</Text>
            )}
          </Text>
        </View>
      </View>

      {streamDone && children && (
        <Animated.View
          style={{ opacity: widgetOpacity, transform: [{ translateY: widgetTranslateY }] }}
          className="ml-11"
        >
          {children}
        </Animated.View>
      )}
    </View>
  )
}
