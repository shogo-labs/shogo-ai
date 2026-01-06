/**
 * TaskStatusBadge - Domain renderer for ImplementationTask.status
 * Task: task-variants
 *
 * Renders task status enum values (planned, in_progress, complete, blocked) with semantic coloring.
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { taskStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type TaskStatus = "planned" | "in_progress" | "complete" | "blocked"

/**
 * Convert snake_case to Title Case for display
 */
function formatTaskStatus(status: string): string {
  return status
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export const TaskStatusBadge = observer(function TaskStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as TaskStatus

  return (
    <Badge className={taskStatusBadgeVariants({ status })}>
      {formatTaskStatus(status)}
    </Badge>
  )
})
