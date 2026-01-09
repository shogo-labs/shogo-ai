/**
 * CursorBlink Component
 * Task: task-chat-003
 *
 * Blinking cursor indicator for active streaming.
 * 500ms blink cycle, respects reduced motion preference.
 */

import { cn } from "@/lib/utils"
import { useReducedMotion } from "@/hooks/useReducedMotion"

export interface CursorBlinkProps {
  /** Whether the cursor should be visible */
  isVisible: boolean
  /** Optional class name */
  className?: string
}

/**
 * Animated blinking cursor for streaming text.
 *
 * Shows a blinking vertical bar at the end of streaming text.
 * Uses --exec-streaming color for consistency with execution state.
 * Respects prefers-reduced-motion (shows static cursor).
 *
 * @example
 * ```tsx
 * <span>
 *   {streamingText}
 *   <CursorBlink isVisible={isStreaming} />
 * </span>
 * ```
 */
export function CursorBlink({ isVisible, className }: CursorBlinkProps) {
  const prefersReducedMotion = useReducedMotion()

  if (!isVisible) {
    return null
  }

  return (
    <span
      className={cn(
        "inline-block w-[2px] h-[1.2em] align-text-bottom ml-0.5",
        "bg-exec-streaming",
        // Apply blink animation unless reduced motion
        !prefersReducedMotion && "cursor-blink",
        className
      )}
      aria-hidden="true"
      data-testid="cursor-blink"
    />
  )
}

export default CursorBlink
