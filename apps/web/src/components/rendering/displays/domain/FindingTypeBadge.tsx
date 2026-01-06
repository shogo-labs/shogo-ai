/**
 * FindingTypeBadge - Domain renderer for AnalysisFinding.type
 * Task: task-variants
 *
 * Renders finding type enum values with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { findingTypeBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type FindingType = "pattern" | "integration_point" | "risk" | "gap" | "existing_test" | "verification" | "classification_evidence"

/**
 * Convert snake_case to Title Case for display
 */
function formatFindingType(type: string): string {
  return type
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export const FindingTypeBadge = observer(function FindingTypeBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const type = String(value) as FindingType

  return (
    <Badge className={findingTypeBadgeVariants({ type })}>
      {formatFindingType(type)}
    </Badge>
  )
})
