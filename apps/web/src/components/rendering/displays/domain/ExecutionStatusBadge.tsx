/**
 * ExecutionStatusBadge - Domain renderer for TaskExecution.status
 * Task: task-variants
 *
 * Renders execution status enum values with semantic coloring.
 * pending, test_written, test_failing, implementing, test_passing, failed
 */

import { observer } from "mobx-react-lite"
import { Badge } from "@/components/ui/badge"
import { executionStatusBadgeVariants } from "./variants"
import type { DisplayRendererProps } from "../../types"

type ExecutionStatus = "pending" | "test_written" | "test_failing" | "implementing" | "test_passing" | "failed"

/**
 * Convert snake_case to Title Case for display
 */
function formatExecutionStatus(status: string): string {
  return status
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export const ExecutionStatusBadge = observer(function ExecutionStatusBadge({
  value,
}: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const status = String(value) as ExecutionStatus

  return (
    <Badge className={executionStatusBadgeVariants({ status })}>
      {formatExecutionStatus(status)}
    </Badge>
  )
})
