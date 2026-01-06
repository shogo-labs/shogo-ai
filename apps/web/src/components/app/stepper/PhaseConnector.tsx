/**
 * PhaseConnector Component
 * Task: task-3-1-001 (redesign from task-2-3a-004)
 *
 * Renders a connecting line between PhaseNodes in the stepper.
 * Styling changes based on whether the preceding phase is complete.
 *
 * Per design-3-1-001:
 * - Connector lines remain between circles at vertical center
 * - Position at 16px from top (center of 32px circles)
 * - PhaseNodes are now vertical stacks with items-start alignment
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
 * Per design-3-1-001:
 * Renders a horizontal line connecting adjacent PhaseNode circles.
 * Positioned at vertical center of 32px circles (mt-4 = 16px from top).
 * Complete state shows green line, incomplete shows muted line.
 */
export function PhaseConnector({ isComplete, index }: PhaseConnectorProps) {
  return (
    <div
      data-testid={`phase-connector-${index}`}
      className={cn(
        // Fixed dimensions for consistent stepper layout
        // mt-4 (16px) positions at vertical center of 32px circles
        "w-6 h-0.5 mt-4",
        // Color based on completion state
        isComplete ? "bg-green-500" : "bg-border"
      )}
      aria-hidden="true"
    />
  )
}
