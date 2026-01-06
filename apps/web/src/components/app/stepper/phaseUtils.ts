/**
 * Phase Utilities
 * Task: task-2-3a-001
 *
 * Constants and utility functions for phase status computation.
 * Uses StatusOrder from @shogo/state-api for authoritative phase ordering.
 *
 * Per design-2-3a-status-computation:
 * - Uses StatusOrder index comparison: targetIndex < currentIndex = complete
 * - Sequential pipeline assumption matches vault 04-skill-workflow.md
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { StatusOrder } from "@shogo/state-api"

// Re-export StatusOrder for convenience
export { StatusOrder }

/**
 * Phase status type for visual representation
 * - pending: Phase not yet reached
 * - current: Currently active phase
 * - complete: Phase has been completed
 * - blocked: Phase is blocked (reserved for 2.3D skill execution failures)
 */
export type PhaseStatus = "pending" | "current" | "complete" | "blocked"

/**
 * Phase configuration with display labels
 */
export interface PhaseConfig {
  /** Full display label */
  label: string
  /** Short label for compact display */
  shortLabel: string
}

/**
 * Configuration for all 8 phases with display labels
 * Maps phase name to label and shortLabel for display
 */
export const PHASE_CONFIG: Record<string, PhaseConfig> = {
  discovery: { label: "Discovery", shortLabel: "Disc" },
  analysis: { label: "Analysis", shortLabel: "Ana" },
  classification: { label: "Classification", shortLabel: "Class" },
  design: { label: "Design", shortLabel: "Des" },
  spec: { label: "Spec", shortLabel: "Spec" },
  implementation: { label: "Implementation", shortLabel: "Impl" },
  testing: { label: "Testing", shortLabel: "Test" },
  complete: { label: "Complete", shortLabel: "Done" },
}

/**
 * Compute phase status based on current feature status and target phase.
 *
 * Per design-2-3a-status-computation:
 * - targetIndex < currentIndex = complete
 * - targetIndex == currentIndex = current
 * - targetIndex > currentIndex = pending
 *
 * Blocked status is reserved for explicit failures (2.3D).
 *
 * @param currentStatus - The current feature status
 * @param targetPhase - The phase to compute status for
 * @returns The computed phase status
 */
export function getPhaseStatus(
  currentStatus: string,
  targetPhase: string
): PhaseStatus {
  const currentIndex = StatusOrder.indexOf(currentStatus)
  const targetIndex = StatusOrder.indexOf(targetPhase)

  // Handle unknown phases
  if (currentIndex === -1 || targetIndex === -1) {
    return "pending"
  }

  if (targetIndex < currentIndex) {
    return "complete"
  } else if (targetIndex === currentIndex) {
    return "current"
  } else {
    return "pending"
  }
}
