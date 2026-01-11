/**
 * PhaseActionsSection Component
 * Task: task-cpv-010
 *
 * Renders phase navigation actions with a primary "Continue" button for advancing
 * to the next phase, plus support for additional config-driven action buttons.
 *
 * Features:
 * - Primary action button for phase advancement
 * - Next phase determination based on feature.status
 * - Disabled state when phase cannot advance (complete or unknown)
 * - Config-driven additional actions (additionalActions array)
 * - Consistent layout with border separator
 */

import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * Phase order for determining next phase
 */
const PHASE_ORDER = [
  "discovery",
  "analysis",
  "classification",
  "design",
  "spec",
  "testing",
  "implementation",
  "complete",
] as const

/**
 * Gets the next phase in the pipeline order.
 *
 * @param current - The current phase status
 * @returns The next phase name, or null if at complete or unknown phase
 */
function getNextPhase(current: string): string | null {
  const idx = PHASE_ORDER.indexOf(current as (typeof PHASE_ORDER)[number])
  if (idx === -1 || idx >= PHASE_ORDER.length - 1) return null
  return PHASE_ORDER[idx + 1]
}

/**
 * Type for additional action configuration
 */
interface AdditionalAction {
  label: string
  variant: "default" | "outline" | "ghost"
  action: string
}

/**
 * PhaseActionsSection renders navigation and action buttons for phase views.
 *
 * Displays:
 * - Next phase indicator text
 * - Primary "Continue" button (or "Done" when complete)
 * - Optional additional action buttons from config
 *
 * @param props - SectionRendererProps with feature and optional config
 */
export function PhaseActionsSection({ feature, config }: SectionRendererProps) {
  const currentStatus = feature?.status ?? ""
  const nextPhase = getNextPhase(currentStatus)
  const canAdvance = nextPhase !== null

  // Extract additional actions from config
  const additionalActions: AdditionalAction[] =
    (config?.additionalActions as AdditionalAction[]) ?? []

  return (
    <div className="flex items-center justify-between p-4 border-t">
      {/* Next phase indicator */}
      <div className="text-sm text-muted-foreground">
        {canAdvance ? `Next: ${nextPhase}` : "Feature complete"}
      </div>

      {/* Action buttons container */}
      <div className="flex items-center gap-2">
        {/* Additional actions from config */}
        {additionalActions.map((action) => (
          <Button
            key={action.action}
            variant={action.variant}
            data-action={action.action}
          >
            {action.label}
          </Button>
        ))}

        {/* Primary action button */}
        <Button disabled={!canAdvance}>
          {canAdvance ? "Continue" : "Done"}
          {canAdvance && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

export default PhaseActionsSection
