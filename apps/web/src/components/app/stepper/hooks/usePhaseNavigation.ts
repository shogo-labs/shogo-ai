/**
 * usePhaseNavigation Hook
 * Task: task-2-3a-002
 *
 * Hook for managing phase URL state (?phase={name}) and computing phase statuses.
 * Uses nuqs for type-safe URL state management.
 *
 * Per design-2-3a-url-state-pattern:
 * - Separate hook from useWorkspaceNavigation for separation of concerns
 * - Default phase is feature.status when URL param is null
 * - URL param is phase name (string), not index
 *
 * Per finding-2-3a-002:
 * - Follows nuqs pattern from useWorkspaceNavigation
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/hooks/
 * - Zero imports from /components/Studio/
 */

import { useMemo } from "react"
import { useQueryState, parseAsString } from "nuqs"
import { StatusOrder } from "@shogo/state-api"
import { getPhaseStatus, type PhaseStatus, PHASE_CONFIG } from "../phaseUtils"

/**
 * Stepper phase data structure returned by the hook.
 * Named StepperPhase to avoid collision with workspace/hooks Phase type.
 */
export interface StepperPhase {
  /** Phase name (e.g., 'discovery', 'analysis') */
  name: string
  /** Computed status based on feature status */
  status: PhaseStatus
  /** Display label */
  label: string
  /** Short label for compact display */
  shortLabel: string
}

/**
 * Return type for usePhaseNavigation hook
 */
export interface UsePhaseNavigationResult {
  /** Current phase from URL or default to featureStatus */
  phase: string
  /** Function to update phase URL param */
  setPhase: (phase: string | null) => Promise<URLSearchParams>
  /** Array of all phases with computed statuses */
  phases: StepperPhase[]
}

/**
 * usePhaseNavigation Hook
 *
 * Manages phase navigation via URL state and computes phase statuses.
 *
 * @param featureStatus - Current feature status (used as default phase)
 * @returns Object with phase, setPhase, and phases array
 *
 * @example
 * ```tsx
 * const { phase, setPhase, phases } = usePhaseNavigation(feature.status)
 *
 * // Navigate to design phase
 * await setPhase('design')
 *
 * // Render phases with statuses
 * phases.map(p => <PhaseNode key={p.name} {...p} />)
 * ```
 */
export function usePhaseNavigation(featureStatus: string): UsePhaseNavigationResult {
  // URL state for phase selection
  const [phaseParam, setPhase] = useQueryState("phase", parseAsString)

  // Current phase: from URL or default to feature status
  const phase = phaseParam ?? featureStatus

  // Compute phases array with statuses
  const phases = useMemo<StepperPhase[]>(() => {
    return StatusOrder.map((name) => {
      const config = PHASE_CONFIG[name]
      return {
        name,
        status: getPhaseStatus(featureStatus, name),
        label: config?.label ?? name,
        shortLabel: config?.shortLabel ?? name,
      }
    })
  }, [featureStatus])

  return {
    phase,
    setPhase,
    phases,
  }
}
