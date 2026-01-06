/**
 * SkillStepper Component
 * Task: task-3-1-001 (redesign from task-2-3a-007)
 *
 * Horizontal stepper composing PhaseNode + PhaseConnector for all 8 phases.
 * Receives phases data and selected phase from parent (PhaseContentPanel).
 *
 * Per design-3-1-001:
 * - Uses flex-row with items-start for aligned tops of variable-height stacks
 * - PhaseNodes are vertical stacks (circle above label)
 * - Connectors positioned at circle vertical center
 *
 * Per vault 04-skill-workflow.md:
 * - 8-phase pipeline: Discovery -> Analysis -> Classification -> Design -> Spec -> Implementation -> Testing -> Complete
 * - Visual legend: Current (filled), Complete (checkmark), Future (outline)
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import React from "react"
import { cn } from "@/lib/utils"
import { PhaseNode } from "./PhaseNode"
import { PhaseConnector } from "./PhaseConnector"
import type { StepperPhase } from "./hooks/usePhaseNavigation"

/**
 * Props for SkillStepper component
 */
export interface SkillStepperProps {
  /** Array of phases with status information */
  phases: StepperPhase[]
  /** Currently selected phase name (may differ from current status) */
  selectedPhase: string | null
  /** Callback when a phase node is clicked */
  onPhaseClick: (phase: string) => void
}

/**
 * SkillStepper Component
 *
 * Per design-3-1-001:
 * Renders a horizontal stepper with 8 PhaseNodes (vertical stacks) and 7 PhaseConnectors.
 * Uses items-start to align tops of variable-height node stacks.
 * Phases are scannable at a glance - current phase and progress immediately identifiable.
 */
export function SkillStepper({
  phases,
  selectedPhase,
  onPhaseClick,
}: SkillStepperProps) {
  return (
    <div
      data-testid="skill-stepper"
      className={cn(
        // items-start aligns tops of variable-height PhaseNode stacks
        "flex flex-row items-start gap-1 p-4 overflow-x-auto",
        "bg-card rounded-lg border"
      )}
    >
      {phases.map((phase, index) => (
        <React.Fragment key={phase.name}>
          <PhaseNode
            name={phase.name}
            label={phase.label}
            status={phase.status}
            isSelected={phase.name === selectedPhase}
            onClick={() => onPhaseClick(phase.name)}
          />
          {/* Render connector after each node except the last */}
          {index < phases.length - 1 && (
            <PhaseConnector
              index={index}
              isComplete={phase.status === "complete"}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
