/**
 * TaskExecutionRow Component
 * Task: task-2-3d-task-execution-row
 *
 * Displays a single TaskExecution within an implementation run list.
 * Shows TDD cycle status, duration, file paths, and errors.
 *
 * Props:
 * - execution: TaskExecution object with status, file paths, timing, errors
 * - taskName: Name of the associated task
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/cards/
 * - Wrapped with observer() for MobX reactivity
 *
 * Per Phase 2 integration:
 * - Uses PropertyRenderer for execution status badge
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { cva, type VariantProps } from "class-variance-authority"
import {
  Clock,
  FileCode,
  FileText,
  ChevronDown,
  ChevronRight,
  RotateCcw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { PropertyRenderer } from "@/components/rendering"

/**
 * Execution status type - matches TaskExecution entity
 */
export type ExecutionStatus =
  | "pending"
  | "test_written"
  | "test_failing"
  | "implementing"
  | "test_passing"
  | "failed"

/**
 * TaskExecution type for row display
 */
export interface TaskExecution {
  id: string
  status: ExecutionStatus
  testFilePath?: string
  implementationFilePath?: string
  testOutput?: string
  retryCount?: number
  errorMessage?: string
  startedAt: number
  completedAt?: number
}

/**
 * Props for TaskExecutionRow component
 */
export interface TaskExecutionRowProps {
  /** Task execution to display */
  execution: TaskExecution
  /** Name of the associated task */
  taskName: string
}

/**
 * CVA variants for execution status badge styling
 * Represents TDD cycle stages
 */
export const executionStatusVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        pending: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
        test_written: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
        test_failing: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        implementing: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        test_passing: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
        failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
)

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

/**
 * Get file name from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath
}

/**
 * TaskExecutionRow Component
 *
 * Renders a single task execution with:
 * - Task name and status badge
 * - Duration when completed
 * - File paths (test and implementation)
 * - Retry count badge if > 0
 * - Expandable error message when failed
 */
export const TaskExecutionRow = observer(function TaskExecutionRow({
  execution,
  taskName,
}: TaskExecutionRowProps) {
  const [isErrorExpanded, setIsErrorExpanded] = useState(false)

  // Calculate duration if completed
  const duration = execution.completedAt
    ? execution.completedAt - execution.startedAt
    : null

  const hasFailed = execution.status === "failed" && execution.errorMessage

  return (
    <div
      data-testid={`task-execution-row-${execution.id}`}
      className={cn(
        "py-3 border-b last:border-b-0",
        "hover:bg-muted/50 transition-colors"
      )}
    >
      {/* Main row content */}
      <div className="flex items-center justify-between gap-4">
        {/* Left: Task name and status */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          {/* Use PropertyRenderer for execution status badge */}
          <PropertyRenderer
            value={execution.status}
            property={{
              name: "status",
              type: "string",
              xRenderer: "execution-status-badge",
            }}
          />
          <span className="text-sm font-medium text-foreground truncate">
            {taskName}
          </span>
        </div>

        {/* Right: Duration, retry count */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {execution.retryCount && execution.retryCount > 0 && (
            <span className="flex items-center gap-1" title="Retry count">
              <RotateCcw className="h-3 w-3" />
              {execution.retryCount}
            </span>
          )}
          {duration !== null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(duration)}
            </span>
          )}
        </div>
      </div>

      {/* File paths */}
      {(execution.testFilePath || execution.implementationFilePath) && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {execution.testFilePath && (
            <span
              className="flex items-center gap-1 font-mono"
              title={execution.testFilePath}
            >
              <FileText className="h-3 w-3" />
              <span className="truncate max-w-[200px]">
                {getFileName(execution.testFilePath)}
              </span>
            </span>
          )}
          {execution.implementationFilePath && (
            <span
              className="flex items-center gap-1 font-mono"
              title={execution.implementationFilePath}
            >
              <FileCode className="h-3 w-3" />
              <span className="truncate max-w-[200px]">
                {getFileName(execution.implementationFilePath)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Error message (expandable) */}
      {hasFailed && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setIsErrorExpanded(!isErrorExpanded)}
            className="flex items-center gap-1 text-xs font-medium text-destructive hover:text-destructive/80 transition-colors"
          >
            {isErrorExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Error Details
          </button>

          {isErrorExpanded && (
            <div className="mt-2 p-2 bg-destructive/10 rounded-md">
              <pre className="text-xs text-destructive whitespace-pre-wrap break-words">
                {execution.errorMessage}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
