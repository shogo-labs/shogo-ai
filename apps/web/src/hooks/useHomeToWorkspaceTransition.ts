/**
 * useHomeToWorkspaceTransition Hook
 *
 * Orchestrates the animated transition from HomePage to ProjectLayout.
 * Uses "early navigation with overlay" approach:
 *
 * 1. User submits prompt
 * 2. Capture homepage input position (startRect)
 * 3. Navigate immediately to project layout
 * 4. Measure real ChatPanel input position (endRect)
 * 5. Show animated overlay from start → end
 * 6. Fade out overlay, reveal real ChatPanel
 *
 * This approach is deterministic because we measure the actual target
 * element position rather than hardcoding it.
 *
 * Respects prefers-reduced-motion via useReducedMotion hook.
 */

import { useState, useCallback, useRef, type RefObject } from "react"
import { useReducedMotion } from "./useReducedMotion"
import type { TransitionPhase } from "@/components/app/workspace/dashboard/HomePage"

// Re-export TransitionPhase for convenience
export type { TransitionPhase }

// Animation durations in milliseconds
const DURATIONS = {
  /** Brief pause before navigation for visual feedback */
  preNavigation: 100,
  /** Delay after navigation to let layout settle before measuring */
  postNavigationSettle: 100,
  /** Main animation from start to end position */
  animation: 400,
  /** Fade out duration for overlay */
  fadeOut: 150,
} as const

// Helper to create a delay promise
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Stored rect for serialization (DOMRect isn't serializable)
export interface SerializableRect {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

function toDOMRect(rect: SerializableRect): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height)
}

function toSerializableRect(rect: DOMRect): SerializableRect {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  }
}

interface UseHomeToWorkspaceTransitionOptions {
  /** Called to collapse the sidebar during transition */
  onSidebarCollapse?: () => void
  /** Called immediately to navigate (early navigation approach) */
  onNavigate?: () => void
  /** Ref to the homepage input for capturing start position */
  sourceRef?: RefObject<HTMLDivElement>
  /** Ref to the target ChatPanel input for measuring end position (set after navigation) */
  targetRef?: RefObject<HTMLDivElement>
}

export interface TransitionOverlayState {
  /** Whether the overlay should be active */
  isActive: boolean
  /** Starting position (from homepage) */
  startRect: DOMRect | null
  /** Ending position (from ChatPanel after navigation) */
  endRect: DOMRect | null
  /** The prompt text being transitioned */
  promptText: string
}

interface UseHomeToWorkspaceTransitionResult {
  /** Current animation phase */
  transitionPhase: TransitionPhase
  /** The prompt text that triggered the transition */
  pendingPrompt: string | null
  /** Start the transition animation with the given prompt */
  startTransition: (prompt: string) => Promise<void>
  /** Whether animation is in progress */
  isTransitioning: boolean
  /** Whether transition has finished */
  isComplete: boolean
  /** Reset to idle state */
  reset: () => void
  /** State for the transition overlay component */
  overlayState: TransitionOverlayState
  /** Call this after navigation when target is ready to be measured */
  measureTarget: () => void
  /** Call this when overlay animation completes */
  onOverlayComplete: () => void
  /** Legacy: FLIP style (for backwards compatibility during migration) */
  flipStyle: React.CSSProperties | null
}

/**
 * Hook that orchestrates the HomePage to ProjectLayout transition animation.
 *
 * @example
 * ```tsx
 * const sourceRef = useRef<HTMLDivElement>(null)
 * const targetRef = useRef<HTMLDivElement>(null)
 *
 * const {
 *   transitionPhase,
 *   pendingPrompt,
 *   startTransition,
 *   overlayState,
 *   measureTarget,
 *   onOverlayComplete,
 * } = useHomeToWorkspaceTransition({
 *   onSidebarCollapse: collapseSidebar,
 *   onNavigate: () => navigate('/projects/...'),
 *   sourceRef,
 *   targetRef,
 * })
 *
 * // After navigation, when target is mounted:
 * useEffect(() => {
 *   if (transitionPhase === 'transform') {
 *     measureTarget()
 *   }
 * }, [transitionPhase, measureTarget])
 * ```
 */
export function useHomeToWorkspaceTransition(
  options: UseHomeToWorkspaceTransitionOptions = {}
): UseHomeToWorkspaceTransitionResult {
  const { onSidebarCollapse, onNavigate, sourceRef, targetRef } = options

  const [transitionPhase, setTransitionPhase] = useState<TransitionPhase>("idle")
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [startRect, setStartRect] = useState<SerializableRect | null>(null)
  const [endRect, setEndRect] = useState<SerializableRect | null>(null)
  const [overlayActive, setOverlayActive] = useState(false)
  const prefersReducedMotion = useReducedMotion()

  // Track if animation is in progress to prevent concurrent transitions
  const isAnimatingRef = useRef(false)

  const startTransition = useCallback(
    async (prompt: string) => {
      // Prevent concurrent transitions
      if (isAnimatingRef.current) {
        return
      }

      isAnimatingRef.current = true
      setPendingPrompt(prompt)

      if (prefersReducedMotion) {
        // Skip animation, instant transition
        onSidebarCollapse?.()
        onNavigate?.()
        setTransitionPhase("complete")
        isAnimatingRef.current = false
        return
      }

      // Phase 1: Commit - Capture position, start collapsing sidebar
      setTransitionPhase("commit")
      onSidebarCollapse?.()

      // Capture starting position for animation
      const sourceRect = sourceRef?.current?.getBoundingClientRect()
      if (sourceRect) {
        setStartRect(toSerializableRect(sourceRect))
      }

      await delay(DURATIONS.preNavigation)

      // Phase 2: Dissolve - Elements fade, prepare for navigation
      setTransitionPhase("dissolve")

      // Navigate immediately (early navigation approach)
      // The real ChatPanel will render in project layout
      onNavigate?.()

      // Phase 3: Transform - waiting for target measurement and overlay animation
      // Note: The actual animation happens in the overlay component
      // measureTarget() should be called by the parent after navigation settles
      setTransitionPhase("transform")
    },
    [prefersReducedMotion, onSidebarCollapse, onNavigate, sourceRef]
  )

  // Called after navigation when target element is available
  const measureTarget = useCallback(() => {
    if (!targetRef?.current || !startRect) return

    // Wait a tick for layout to settle
    requestAnimationFrame(() => {
      const targetRect = targetRef.current?.getBoundingClientRect()
      if (targetRect) {
        setEndRect(toSerializableRect(targetRect))
        setOverlayActive(true)
      }
    })
  }, [targetRef, startRect])

  // Called when overlay animation completes
  const onOverlayComplete = useCallback(() => {
    setOverlayActive(false)
    setTransitionPhase("complete")
    isAnimatingRef.current = false
  }, [])

  const reset = useCallback(() => {
    setTransitionPhase("idle")
    setPendingPrompt(null)
    setStartRect(null)
    setEndRect(null)
    setOverlayActive(false)
    isAnimatingRef.current = false
  }, [])

  // Build overlay state for the overlay component
  const overlayState: TransitionOverlayState = {
    isActive: overlayActive,
    startRect: startRect ? toDOMRect(startRect) : null,
    endRect: endRect ? toDOMRect(endRect) : null,
    promptText: pendingPrompt ?? "",
  }

  // Legacy flipStyle for backwards compatibility during migration
  // This can be removed once all usages are updated to use overlay
  const flipStyle = startRect
    ? {
        position: 'fixed' as const,
        top: startRect.top,
        left: startRect.left,
        width: startRect.width,
        zIndex: 9999,
      }
    : null

  return {
    transitionPhase,
    pendingPrompt,
    startTransition,
    isTransitioning: transitionPhase !== "idle" && transitionPhase !== "complete",
    isComplete: transitionPhase === "complete",
    reset,
    overlayState,
    measureTarget,
    onOverlayComplete,
    flipStyle,
  }
}

export default useHomeToWorkspaceTransition
