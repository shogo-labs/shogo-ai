/**
 * ExecutionProgress Component
 * Task: task-2-3d-execution-progress
 *
 * Displays overall implementation run status with progress bar and current task.
 *
 * Props:
 * - run: ImplementationRun object with status, completedTasks, startedAt, currentTaskId
 * - totalTasks: Total number of tasks in the session
 * - currentTaskName: Name of the currently executing task (optional)
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/cards/
 * - Wrapped with observer() for MobX reactivity
 *
 * Per design-2-3d-cva-variants:
 * - runStatusVariants: in_progress=blue, blocked=amber, complete=green, failed=red
 */

import { useMemo } from "react"
import { observer } from "mobx-react-lite"
import { cva, type VariantProps } from "class-variance-authority"
import { Play, CheckCircle, AlertCircle, Clock, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Run status type - matches ImplementationRun entity
 */
export type RunStatus = "in_progress" | "blocked" | "complete" | "failed"

/**
 * ImplementationRun type for progress display
 */
export interface ImplementationRun {
  id: string
  status: RunStatus
  completedTasks: string[]
  failedTasks?: string[]
  startedAt: number
  completedAt?: number
  currentTaskId?: string
  lastError?: string
}

/**
 * Props for ExecutionProgress component
 */
export interface ExecutionProgressProps {
  /** Implementation run to display (null if no run) */
  run: ImplementationRun | null | undefined
  /** Total number of tasks in the session */
  totalTasks: number
  /** Name of the currently executing task */
  currentTaskName?: string
}

/**
 * CVA variants for run status badge styling
 */
export const runStatusVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        blocked: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
        complete: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
        failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      },
    },
    defaultVariants: {
      status: "in_progress",
    },
  }
)

/**
 * Get display label for run status
 */
function getStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    in_progress: "In Progress",
    blocked: "Blocked",
    complete: "Complete",
    failed: "Failed",
  }
  return labels[status] || status
}

/**
 * Get status icon component
 */
function getStatusIcon(status: RunStatus) {
  switch (status) {
    case "complete":
      return CheckCircle
    case "failed":
      return XCircle
    case "blocked":
      return AlertCircle
    case "in_progress":
    default:
      return Play
  }
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

/**
 * ExecutionProgress Component
 *
 * Renders implementation run progress with:
 * - Status badge with icon
 * - Progress bar showing completed/total tasks
 * - Elapsed time since run started
 * - Current task name (when in progress)
 */
export const ExecutionProgress = observer(function ExecutionProgress({
  run,
  totalTasks,
  currentTaskName,
}: ExecutionProgressProps) {
  // Return null if no run
  if (!run) {
    return null
  }

  const statusKey = run.status as VariantProps<typeof runStatusVariants>["status"]
  const StatusIcon = getStatusIcon(run.status)

  const completedCount = run.completedTasks?.length || 0
  const progress = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0

  // Calculate elapsed time
  const elapsed = useMemo(() => {
    const endTime = run.completedAt || Date.now()
    return endTime - run.startedAt
  }, [run.startedAt, run.completedAt])

  return (
    <Card
      data-testid={`execution-progress-${run.id}`}
      className="transition-all"
    >
      <CardContent className="p-4 space-y-3">
        {/* Header row: Status badge + elapsed time */}
        <div className="flex items-center justify-between">
          <span className={runStatusVariants({ status: statusKey })}>
            <StatusIcon className="h-3 w-3" />
            {getStatusLabel(run.status)}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDuration(elapsed)}
          </span>
        </div>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>{completedCount} / {totalTasks} tasks ({progress}%)</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all duration-300",
                run.status === "complete" ? "bg-green-500" :
                run.status === "failed" ? "bg-red-500" :
                run.status === "blocked" ? "bg-amber-500" :
                "bg-blue-500"
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Current task (when in progress) */}
        {run.status === "in_progress" && currentTaskName && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Current:</span>
            <span className="text-foreground font-medium truncate">
              {currentTaskName}
            </span>
          </div>
        )}

        {/* Error message (when failed) */}
        {run.status === "failed" && run.lastError && (
          <div className="p-2 bg-destructive/10 rounded-md">
            <p className="text-xs text-destructive line-clamp-2">
              {run.lastError}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
