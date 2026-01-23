/**
 * TaskExecutionTimelineSection
 * Task: task-implementation-004
 *
 * Shows list of TaskExecutions with timeline connector visualization
 * and selection interaction.
 *
 * Features:
 * - Timeline connector: status dot + vertical line to next item
 * - Status dot colors: green (passing), red (failing), amber+pulse (in_progress), muted (default)
 * - Selected execution highlighted with red-500/10 bg and red-500/30 border
 * - Scrollable list with max-h-[300px] overflow-auto
 */

import React, { useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { cn } from "@/lib/utils"
import { Play, CheckCircle, XCircle, Clock, ChevronRight } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { SectionRendererProps } from "../../types"
import { useImplementationPanelContext, type TaskExecution } from "./ImplementationPanelContext"

/**
 * Get status color class for status dot
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "test_passing":
    case "complete":
      return "bg-green-500"
    case "test_failing":
      return "bg-red-500"
    case "in_progress":
      return "bg-amber-500 animate-pulse"
    default:
      return "bg-muted-foreground"
  }
}

/**
 * Get status icon component based on status
 */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "test_passing":
    case "complete":
      return <CheckCircle className="h-4 w-4 text-green-500" data-testid="status-icon-passing" />
    case "test_failing":
      return <XCircle className="h-4 w-4 text-red-500" data-testid="status-icon-failing" />
    case "in_progress":
      return <Play className="h-4 w-4 text-amber-500" data-testid="status-icon-progress" />
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" data-testid="status-icon-default" />
  }
}

/**
 * TaskExecutionTimelineSection Component
 *
 * Displays a vertical timeline of task executions with status indicators.
 * Clicking an execution selects it for display in LiveOutputTerminalSection.
 */
export const TaskExecutionTimelineSection = observer(function TaskExecutionTimelineSection({
  feature,
  config,
}: SectionRendererProps) {
  const phaseColors = usePhaseColor("implementation")
  const { sortedExecutions, selectedExecutionId, setSelectedExecutionId } = useImplementationPanelContext()
  const { platformFeatures } = useDomains()

  /**
   * Get task name from execution
   * Checks execution.task.name first, then looks up from collection
   */
  const getTaskName = (execution: TaskExecution): string => {
    // Check if task is an object with name property
    if (execution.task && typeof execution.task === "object" && execution.task.name) {
      return execution.task.name
    }

    // Otherwise task is a string ID, look it up
    const taskId = typeof execution.task === "string" ? execution.task : execution.task?.id
    if (taskId && platformFeatures?.implementationTaskCollection?.get) {
      const task = platformFeatures.implementationTaskCollection.get(taskId)
      return task?.name || "Unknown Task"
    }

    return "Unknown Task"
  }

  /**
   * Handle execution click
   */
  const handleSelect = (exec: TaskExecution) => {
    setSelectedExecutionId(exec.id)
  }

  return (
    <div
      data-testid="task-execution-timeline-section"
      className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}
    >
      {/* Header */}
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <Play className="h-4 w-4" />
        Task Executions ({sortedExecutions.length})
      </h4>

      {/* Execution List */}
      <div className="space-y-1 max-h-[300px] overflow-auto" data-testid="execution-list">
        {sortedExecutions.map((exec, index) => (
          <button
            key={exec.id}
            onClick={() => handleSelect(exec)}
            data-testid={`execution-item-${exec.id}`}
            className={cn(
              "w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors",
              selectedExecutionId === exec.id
                ? "bg-red-500/10 border border-red-500/30"
                : "hover:bg-muted/50"
            )}
          >
            {/* Timeline connector */}
            <div className="flex flex-col items-center" data-testid="timeline-connector">
              <div className={cn("w-2.5 h-2.5 rounded-full", getStatusColor(exec.status))} />
              {index < sortedExecutions.length - 1 && (
                <div className="w-0.5 h-4 bg-border mt-1" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <StatusIcon status={exec.status} />
                <span className="text-sm font-medium text-foreground truncate">
                  {getTaskName(exec)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground" data-testid="status-label">
                {exec.status.replace(/_/g, " ")}
              </div>
            </div>

            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          </button>
        ))}

        {/* Empty state */}
        {sortedExecutions.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4" data-testid="empty-state">
            No executions yet
          </div>
        )}
      </div>
    </div>
  )
})

export default TaskExecutionTimelineSection
