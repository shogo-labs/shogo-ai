/**
 * StreamingText Component (React Native)
 *
 * Renders text chunks with fade-in animation during streaming.
 * Uses useStreamingText hook internally.
 */

import { Text } from "react-native"
import { useEffect } from "react"
import { cn } from "@shogo/shared-ui/primitives"
import Animated, {
  FadeIn,
} from "react-native-reanimated"
import { useStreamingText } from "./useStreamingText"
import { CursorBlink } from "./CursorBlink"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface StreamingTextProps {
  content: string
  isStreaming: boolean
  className?: string
  showCursor?: boolean
}

const AnimatedText = Animated.createAnimatedComponent(Text)

export function StreamingText({
  content,
  isStreaming,
  className,
  showCursor = true,
}: StreamingTextProps) {
  const { chunks } = useStreamingText(content, isStreaming)
  const prefersReducedMotion = useReducedMotion()

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
        chunk.isNew && !prefersReducedMotion ? (
          <AnimatedText
            key={chunk.id}
            entering={FadeIn.duration(200)}
            className="text-foreground"
          >
            {chunk.text}
          </AnimatedText>
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
