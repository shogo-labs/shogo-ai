/**
 * useHomeToWorkspaceTransition Hook
 *
 * Orchestrates the animated transition from HomePage to a split-panel workspace layout.
 * Manages a 5-phase animation state machine:
 * 1. commit (150ms)    - Input lifts, gains shadow
 * 2. dissolve (300ms)  - Non-essential elements fade out
 * 3. transform (400ms) - React swaps to ComposingWorkspaceView
 * 4. emerge (350ms)    - Workspace panel slides in
 * 5. settle (200ms)    - Chat header appears, polish
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
  emerge: 350,
  settle: 200,
} as const

// Helper to create a delay promise
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * Hook that orchestrates the HomePage to Workspace transition animation.
 *
 * @example
 * ```tsx
 * const { transitionPhase, pendingPrompt, startTransition, isComplete } = useHomeToWorkspaceTransition()
 *
 * const handlePromptSubmit = async (prompt: string) => {
 *   await startTransition(prompt)
 *   // Animation complete, session should be ready
 * }
 *
 * if (transitionPhase !== 'idle') {
 *   return <HomePage transitionPhase={transitionPhase} />
 * }
 * ```
 */
export function useHomeToWorkspaceTransition(): UseHomeToWorkspaceTransitionResult {
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
        setTransitionPhase("complete")
        isAnimatingRef.current = false
        return
      }

      // Phase 1: Commit
      setTransitionPhase("commit")
      await delay(PHASE_DURATIONS.commit)

      // Phase 2: Dissolve
      setTransitionPhase("dissolve")
      await delay(PHASE_DURATIONS.dissolve)

      // Phase 3: Transform
      setTransitionPhase("transform")
      await delay(PHASE_DURATIONS.transform)

      // Phase 4: Emerge
      setTransitionPhase("emerge")
      await delay(PHASE_DURATIONS.emerge)

      // Phase 5: Settle
      setTransitionPhase("settle")
      await delay(PHASE_DURATIONS.settle)

      // Complete
      setTransitionPhase("complete")
      isAnimatingRef.current = false
    },
    [prefersReducedMotion]
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
