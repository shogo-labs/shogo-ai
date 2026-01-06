/**
 * RunStatusBadge - Domain renderer for ImplementationRun.status
 * Task: task-variants
 *
 * Renders run status enum values (in_progress, blocked, complete, failed) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { runStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type RunStatus = "in_progress" | "blocked" | "complete" | "failed"

/**
 * Convert snake_case to Title Case for display
 */
function formatRunStatus(status: string): string {
  return status
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export const RunStatusBadge = observer(function RunStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as RunStatus

  return (
    <Badge className={runStatusBadgeVariants({ status })}>
      {formatRunStatus(status)}
    </Badge>
  )
})
