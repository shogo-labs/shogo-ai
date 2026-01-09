/**
 * StreamingText Component
 * Task: task-chat-003
 *
 * Renders text chunks with fade-in animation during streaming.
 * Uses useStreamingText hook internally or accepts chunks directly.
 */

import { cn } from "@/lib/utils"
import { useStreamingText, type TextChunk } from "./useStreamingText"
import { CursorBlink } from "./CursorBlink"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface StreamingTextProps {
  /** The text content to display */
  content: string
  /** Whether content is actively streaming */
  isStreaming: boolean
  /** Optional class name for the container */
  className?: string
  /** Whether to show the blinking cursor during streaming */
  showCursor?: boolean
}

/**
 * Renders streaming text with progressive fade-in animation.
 *
 * During streaming, text chunks fade in as they arrive.
 * After streaming completes, all text is shown statically.
 * Respects prefers-reduced-motion preference.
 *
 * @example
 * ```tsx
 * <StreamingText
 *   content={assistantMessage}
 *   isStreaming={isLoading}
 *   showCursor
 * />
 * ```
 */
export function StreamingText({
  content,
  isStreaming,
  className,
  showCursor = true,
}: StreamingTextProps) {
  const { chunks } = useStreamingText(content, isStreaming)
  const prefersReducedMotion = useReducedMotion()

  // If not streaming and no chunks yet, render content directly
  if (!isStreaming && chunks.length === 0 && content) {
    return (
      <span className={cn("whitespace-pre-wrap break-words", className)}>
        {content}
      </span>
    )
  }

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {chunks.map((chunk) => (
        <span
          key={chunk.id}
          className={cn(
            // Apply fade-in animation for new chunks (unless reduced motion)
            chunk.isNew && !prefersReducedMotion && "animate-fade-in-chunk",
            // After animation completes, ensure full opacity
            !chunk.isNew && "opacity-100"
          )}
        >
          {chunk.text}
        </span>
      ))}
      {/* Blinking cursor at end during streaming */}
      {showCursor && <CursorBlink isVisible={isStreaming} />}
    </span>
  )
}

export default StreamingText
