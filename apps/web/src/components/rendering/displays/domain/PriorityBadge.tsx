/**
 * PriorityBadge - Domain renderer for Requirement.priority
 * Task: task-variants
 *
 * Renders priority enum values (must, should, could) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { priorityBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

export const PriorityBadge = observer(function PriorityBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const priority = String(value) as "must" | "should" | "could"

  return (
    <Badge className={priorityBadgeVariants({ priority })}>
      {priority}
    </Badge>
  )
})
