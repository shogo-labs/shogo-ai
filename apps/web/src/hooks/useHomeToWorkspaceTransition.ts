/**
 * useHomeToWorkspaceTransition Hook
 *
 * Orchestrates the animated transition from HomePage to ProjectLayout.
 * Manages a 3-phase animation state machine:
 * 1. commit (150ms)    - Input lifts, gains shadow, sidebar starts collapsing
 * 2. dissolve (300ms)  - Non-essential elements fade out, sidebar fully collapses
 * 3. transform (400ms) - Navigate to /projects/{id} (ProjectLayout takes over)
 *
 * After navigation, ProjectLayout handles the rest:
 * - Chat panel on left receives initialMessage and starts streaming
 * - Workspace panel slides in from right
 *
 * Respects prefers-reduced-motion via useReducedMotion hook.
 */

import { useState, useCallback, useRef } from "react"
import { useReducedMotion } from "./useReducedMotion"
import type { TransitionPhase } from "@/components/app/workspace/dashboard/HomePage"

// Re-export TransitionPhase for convenience
export type { TransitionPhase }

// Phase durations in milliseconds
const PHASE_DURATIONS = {
  commit: 150,
  dissolve: 300,
  transform: 400,
  emerge: 350,  // No longer used (navigation happens at transform)
  settle: 200,  // No longer used (navigation happens at transform)
} as const

// Helper to create a delay promise
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface UseHomeToWorkspaceTransitionOptions {
  /** Called at commit phase to collapse the sidebar */
  onSidebarCollapse?: () => void
  /** Called at transform phase to trigger navigation */
  onNavigate?: () => void
}

interface UseHomeToWorkspaceTransitionResult {
  /** Current animation phase */
  transitionPhase: TransitionPhase
  /** The prompt text that triggered the transition */
  pendingPrompt: string | null
  /** Start the transition animation with the given prompt */
  startTransition: (prompt: string) => Promise<void>
  /** Whether animation is in progress (not idle and not complete) */
  isTransitioning: boolean
  /** Whether transition has finished (phase is 'complete') */
  isComplete: boolean
  /** Reset to idle state */
  reset: () => void
}

/**
 * Hook that orchestrates the HomePage to ProjectLayout transition animation.
 *
 * @example
 * ```tsx
 * const { collapseSidebar } = useSidebarCollapseContext()
 * const navigate = useNavigate()
 *
 * const { transitionPhase, pendingPrompt, startTransition } = useHomeToWorkspaceTransition({
 *   onSidebarCollapse: collapseSidebar,
 *   onNavigate: () => navigate(`/projects/${projectId}?chatSessionId=${sessionId}`, { state: {...} }),
 * })
 *
 * const handlePromptSubmit = async (prompt: string) => {
 *   // Create project/session first...
 *   await startTransition(prompt)
 *   // Navigation happens during transform phase
 * }
 * ```
 */
export function useHomeToWorkspaceTransition(
  options: UseHomeToWorkspaceTransitionOptions = {}
): UseHomeToWorkspaceTransitionResult {
  const { onSidebarCollapse, onNavigate } = options

  const [transitionPhase, setTransitionPhase] = useState<TransitionPhase>("idle")
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
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

      // Phase 1: Commit - Input lifts, sidebar starts collapsing
      setTransitionPhase("commit")
      onSidebarCollapse?.()
      await delay(PHASE_DURATIONS.commit)

      // Phase 2: Dissolve - Elements fade out, sidebar fully collapses
      setTransitionPhase("dissolve")
      await delay(PHASE_DURATIONS.dissolve)

      // Phase 3: Transform - Navigate to ProjectLayout
      setTransitionPhase("transform")
      onNavigate?.()
      // No more waiting - navigation takes over

      // Mark as complete (though we're navigating away)
      setTransitionPhase("complete")
      isAnimatingRef.current = false
    },
    [prefersReducedMotion, onSidebarCollapse, onNavigate]
  )

  const reset = useCallback(() => {
    setTransitionPhase("idle")
    setPendingPrompt(null)
    isAnimatingRef.current = false
  }, [])

  return {
    transitionPhase,
    pendingPrompt,
    startTransition,
    isTransitioning: transitionPhase !== "idle" && transitionPhase !== "complete",
    isComplete: transitionPhase === "complete",
    reset,
  }
}

export default useHomeToWorkspaceTransition
