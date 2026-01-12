/**
 * IntegrationPointsSection - Internal sub-component for SpecContainerSection
 * Task: task-spec-004
 *
 * Displays a list of IntegrationPoints for a task with:
 * - Header with Link2 icon, 'Integration Points' label (uppercase tracking-wider), and count badge
 * - IntegrationPointCard for each integration point in space-y-2 container
 * - Emerald icon color (text-emerald-500)
 *
 * Returns null when integrationPoints is empty or undefined.
 *
 * This is an INTERNAL sub-component - NOT registered in sectionImplementationMap.
 * Used by SpecContainerSection's TaskDetailsPanel.
 */

import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { IntegrationPointCard, type IntegrationPoint } from "./IntegrationPointCard"

/**
 * Props for IntegrationPointsSection component
 */
export interface IntegrationPointsSectionProps {
  /** Array of integration points to display */
  integrationPoints: IntegrationPoint[]
}

/**
 * IntegrationPointsSection - displays a list of IntegrationPoints
 * Task: task-spec-004
 *
 * Features:
 * - Header with Link2 icon (text-emerald-500)
 * - 'Integration Points' label (uppercase, tracking-wider)
 * - Count badge showing number of items
 * - Maps over integrationPoints to render IntegrationPointCard for each
 * - Container with space-y-2 for vertical spacing
 *
 * @param integrationPoints - Array of integration points to display
 * @returns null if integrationPoints is empty or undefined
 */
export function IntegrationPointsSection({ integrationPoints }: IntegrationPointsSectionProps) {
  // Return null when integrationPoints is empty or undefined
  if (!integrationPoints || integrationPoints.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {/* Header with icon, label, and count */}
      <div className="flex items-center gap-2">
        <Link2 className={cn("h-4 w-4 shrink-0", "text-emerald-500")} />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Integration Points
        </span>
        <span className="text-xs text-muted-foreground">
          ({integrationPoints.length})
        </span>
      </div>

      {/* List of IntegrationPointCards */}
      <div className="space-y-2">
        {integrationPoints.map((integrationPoint) => (
          <IntegrationPointCard
            key={integrationPoint.id}
            integrationPoint={integrationPoint}
          />
        ))}
      </div>
    </div>
  )
}

export default IntegrationPointsSection
