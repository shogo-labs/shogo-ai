/**
 * ChatPanelTransitionOverlay - Animates chat input from homepage to project layout
 *
 * This component renders a portal-based overlay that:
 * 1. Captures the visual appearance of the homepage compact input
 * 2. Animates from the captured start position to the measured end position
 * 3. Fades out when animation completes, revealing the real ChatPanel
 *
 * Used for the homepage → project transition animation with early navigation.
 */

import { useEffect, useState, useRef } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { CompactChatInput } from "./CompactChatInput"

export interface TransitionOverlayProps {
  /** Starting position (captured from homepage input before navigation) */
  startRect: DOMRect
  /** Ending position (measured from real ChatPanel input after navigation) */
  endRect: DOMRect
  /** The prompt text to display in the overlay */
  promptText: string
  /** Callback when animation completes */
  onComplete: () => void
  /** Animation duration in ms (default: 400) */
  duration?: number
  /** Whether to show the overlay (controls visibility) */
  isActive: boolean
}

type AnimationPhase = 'idle' | 'animating' | 'fading' | 'complete'

/**
 * Transition overlay that animates from homepage input position to ChatPanel position
 */
export function ChatPanelTransitionOverlay({
  startRect,
  endRect,
  promptText,
  onComplete,
  duration = 400,
  isActive,
}: TransitionOverlayProps) {
  const [phase, setPhase] = useState<AnimationPhase>('idle')
  const containerRef = useRef<HTMLDivElement>(null)

  // Start animation when active
  useEffect(() => {
    if (!isActive) {
      setPhase('idle')
      return
    }

    // Start at beginning position
    setPhase('animating')

    // Wait for animation to complete
    const animationTimer = setTimeout(() => {
      setPhase('fading')
    }, duration)

    // Fade out duration
    const fadeTimer = setTimeout(() => {
      setPhase('complete')
      onComplete()
    }, duration + 150) // 150ms fade

    return () => {
      clearTimeout(animationTimer)
      clearTimeout(fadeTimer)
    }
  }, [isActive, duration, onComplete])

  // Trigger animation by setting end values after initial render
  // IMPORTANT: This hook must be called unconditionally (before any early returns)
  useEffect(() => {
    if (phase === 'animating' && containerRef.current) {
      // Force a reflow, then set end position
      containerRef.current.getBoundingClientRect()
      containerRef.current.style.top = `${endRect.top}px`
      containerRef.current.style.left = `${endRect.left}px`
      containerRef.current.style.width = `${endRect.width}px`
    }
  }, [phase, endRect])

  // Don't render if not active or complete
  if (!isActive || phase === 'complete' || phase === 'idle') {
    return null
  }

  // Calculate current position based on phase
  const isAnimating = phase === 'animating'
  const isFading = phase === 'fading'

  // CSS custom properties for animation
  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 10000,
    // Start position
    '--start-top': `${startRect.top}px`,
    '--start-left': `${startRect.left}px`,
    '--start-width': `${startRect.width}px`,
    // End position
    '--end-top': `${endRect.top}px`,
    '--end-left': `${endRect.left}px`,
    '--end-width': `${endRect.width}px`,
    // Initial values (will be animated)
    top: isAnimating ? startRect.top : endRect.top,
    left: isAnimating ? startRect.left : endRect.left,
    width: isAnimating ? startRect.width : endRect.width,
    // Opacity for fade
    opacity: isFading ? 0 : 1,
    // Animation
    transition: isAnimating
      ? `all ${duration}ms cubic-bezier(0.34, 1.56, 0.64, 1)`
      : 'opacity 150ms ease-out',
    // Pointer events disabled during animation
    pointerEvents: 'none',
  } as React.CSSProperties

  const overlay = (
    <div
      ref={containerRef}
      className={cn(
        "transition-overlay",
        // Elevated appearance during animation
        "shadow-2xl"
      )}
      style={style}
      data-transition-phase={phase}
    >
      <CompactChatInput
        onSubmit={() => {}} // No-op, overlay is non-interactive
        disabled
        value={promptText}
        isLoading
      />
    </div>
  )

  // Render via portal to escape any overflow:hidden parents
  return createPortal(overlay, document.body)
}

export default ChatPanelTransitionOverlay
