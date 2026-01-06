/**
 * PhaseConnector Component
 * Task: task-2-3a-004
 *
 * Renders a connecting line between PhaseNodes in the stepper.
 * Styling changes based on whether the preceding phase is complete.
 *
 * Per design-2-3a-component-hierarchy:
 * - Simple presentational component
 * - Visual state determined by isComplete prop
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { cn } from "@/lib/utils"

/**
 * Props for PhaseConnector component
 */
export interface PhaseConnectorProps {
  /** Whether the preceding phase is complete */
  isComplete: boolean
  /** Index for data-testid attribute */
  index: number
}

/**
 * PhaseConnector Component
 *
 * Renders a horizontal line connecting adjacent PhaseNodes.
 * Complete state shows green line, incomplete shows muted line.
 */
export function PhaseConnector({ isComplete, index }: PhaseConnectorProps) {
  return (
    <div
      data-testid={`phase-connector-${index}`}
      className={cn(
        // Fixed dimensions for consistent stepper layout
        "w-8 h-0.5 self-center",
        // Color based on completion state
        isComplete ? "bg-green-500" : "bg-border"
      )}
      aria-hidden="true"
    />
  )
}
