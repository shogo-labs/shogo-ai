/**
 * Empty State Components
 * Task: task-2-3a-005
 *
 * EmptyPhaseContent and BlockedPhaseIndicator for phase empty and blocked states.
 *
 * Per vault 04-skill-workflow.md Phase State Machine:
 * - EmptyPhaseContent: Phase has no data, optionally show run button
 * - BlockedPhaseIndicator: Phase cannot run because prerequisite is incomplete
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { AlertCircle, FileQuestion } from "lucide-react"
import { cn } from "@/lib/utils"
import { RunPhaseButton } from "./RunPhaseButton"
import { PHASE_CONFIG } from "./phaseUtils"

/**
 * Props for EmptyPhaseContent component
 */
export interface EmptyPhaseContentProps {
  /** Phase name for display in message */
  phaseName: string
  /** Feature name for skill invocation (task-2-4-006) */
  featureName?: string
  /** Optional callback to run the phase (provided in 2.3D) */
  onRunPhase?: () => void
}

/**
 * EmptyPhaseContent Component
 *
 * Displays when a phase has no data yet.
 * Shows RunPhaseButton that wires to ChatContext when featureName is provided (2.4).
 * Optionally shows RunPhaseButton with onRunPhase callback when provided (legacy).
 */
export function EmptyPhaseContent({
  phaseName,
  featureName,
  onRunPhase,
}: EmptyPhaseContentProps) {
  const phaseLabel = PHASE_CONFIG[phaseName]?.label || phaseName

  return (
    <div
      data-testid="empty-phase-content"
      className={cn(
        "flex flex-col items-center justify-center p-8 rounded-lg border border-dashed",
        "bg-muted/30 text-center min-h-[200px]"
      )}
    >
      <FileQuestion className="w-12 h-12 text-muted-foreground/50 mb-4" />
      <h3 className="text-lg font-medium text-foreground mb-2">
        No {phaseLabel} data yet
      </h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        Run the {phaseLabel.toLowerCase()} phase to generate content for this section.
      </p>
      {/* Show RunPhaseButton with onRunPhase callback (legacy) or featureName (2.4 ChatContext wiring) */}
      {(onRunPhase || featureName) && (
        <RunPhaseButton
          phaseName={phaseName}
          featureName={featureName}
          disabled={!!onRunPhase ? false : undefined}
          onRun={onRunPhase}
        />
      )}
    </div>
  )
}

/**
 * Props for BlockedPhaseIndicator component
 */
export interface BlockedPhaseIndicatorProps {
  /** Name of the phase that must complete first */
  blockedBy: string
}

/**
 * BlockedPhaseIndicator Component
 *
 * Displays when a phase cannot run because a prerequisite phase is incomplete.
 */
export function BlockedPhaseIndicator({
  blockedBy,
}: BlockedPhaseIndicatorProps) {
  const blockedByLabel = PHASE_CONFIG[blockedBy]?.label || blockedBy

  return (
    <div
      data-testid="blocked-phase-indicator"
      className={cn(
        "flex flex-col items-center justify-center p-8 rounded-lg border",
        "border-destructive/30 bg-destructive/5 text-center min-h-[200px]"
      )}
    >
      <AlertCircle className="w-12 h-12 text-destructive/50 mb-4" />
      <h3 className="text-lg font-medium text-destructive mb-2">
        Phase Blocked
      </h3>
      <p className="text-sm text-muted-foreground max-w-md">
        Complete the <span className="font-medium text-foreground">{blockedByLabel}</span> phase first
        before proceeding to this phase.
      </p>
    </div>
  )
}
