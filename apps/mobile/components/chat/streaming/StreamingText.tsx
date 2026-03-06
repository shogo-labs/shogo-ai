/**
 * StreamingText Component (React Native)
 *
 * Renders text chunks with fade-in animation during streaming.
 * Uses React Native's built-in Animated API.
 */

import { Text, Animated } from "react-native"
import { useEffect, useRef } from "react"
import { cn } from "@shogo/shared-ui/primitives"
import { useStreamingText } from "./useStreamingText"
import { CursorBlink } from "./CursorBlink"

export interface StreamingTextProps {
  content: string
  isStreaming: boolean
  className?: string
  showCursor?: boolean
}

function FadeInText({ children }: { children: string }) {
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start()
  }, [])

  return (
    <Animated.Text className="text-foreground" style={{ opacity }}>
      {children}
    </Animated.Text>
  )
}

export function StreamingText({
  content,
  isStreaming,
  className,
  showCursor = true,
}: StreamingTextProps) {
  const { chunks } = useStreamingText(content, isStreaming)

  if (!isStreaming && chunks.length === 0 && content) {
    return (
      <Text className={cn("text-foreground", className)}>
        {content}
      </Text>
    )
  }

  return (
    <Animated.View className={cn("flex-row flex-wrap", className)}>
      {chunks.map((chunk) =>
        chunk.isNew ? (
          <FadeInText key={chunk.id}>{chunk.text}</FadeInText>
        ) : (
          <Text key={chunk.id} className="text-foreground">
            {chunk.text}
          </Text>
        )
      )}
      {showCursor && <CursorBlink isVisible={isStreaming} />}
    </Animated.View>
  )
}

export default StreamingText
