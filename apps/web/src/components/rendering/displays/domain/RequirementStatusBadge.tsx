/**
 * RequirementStatusBadge - Domain renderer for Requirement.status
 * Task: task-variants
 *
 * Renders requirement status enum values (proposed, accepted, implemented) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { requirementStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type RequirementStatus = "proposed" | "accepted" | "implemented"

export const RequirementStatusBadge = observer(function RequirementStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as RequirementStatus

  return (
    <Badge className={requirementStatusBadgeVariants({ status })}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
})
