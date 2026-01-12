/**
 * LiveOutputTerminalSection
 * Task: task-implementation-005
 *
 * Shows terminal-style output for selected task execution.
 * Reads selectedExecutionId and sortedExecutions from ImplementationPanelContext.
 *
 * Features:
 * - Header with Terminal icon and task name
 * - Dark terminal body with mono font
 * - Output colored red for test_failing, green for test_passing
 * - File paths section when testFilePath or implementationFilePath exist
 * - Empty state when no execution available
 */

import React, { useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { Terminal } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { SectionRendererProps } from "../../types"
import { useImplementationPanelContext, type TaskExecution } from "./ImplementationPanelContext"

/**
 * Get output color class based on execution status
 */
function getOutputColorClass(status: string): string {
  switch (status) {
    case "test_passing":
    case "complete":
      return "text-green-400"
    case "test_failing":
    case "failed":
      return "text-red-400"
    default:
      return "text-muted-foreground"
  }
}

/**
 * Get task name from execution
 */
function getTaskName(execution: TaskExecution, platformFeatures: any): string {
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
 * LiveOutputTerminalSection Component
 *
 * Displays terminal-style output for selected or latest task execution.
 * Uses ImplementationPanelContext for execution state.
 */
export const LiveOutputTerminalSection = observer(function LiveOutputTerminalSection({
  feature,
  config,
}: SectionRendererProps) {
  const phaseColors = usePhaseColor("implementation")
  const { selectedExecutionId, sortedExecutions } = useImplementationPanelContext()
  const { platformFeatures } = useDomains()

  // Get the execution to display
  const displayExecution: TaskExecution | null = useMemo(() => {
    if (selectedExecutionId) {
      return sortedExecutions.find((e) => e.id === selectedExecutionId) || null
    }
    // Fallback to most recent (first after sort by startedAt desc)
    return sortedExecutions[0] || null
  }, [selectedExecutionId, sortedExecutions])

  // Get output content
  const outputContent = displayExecution?.testOutput || displayExecution?.errorMessage || null
  const hasOutput = !!outputContent
  const hasFilePaths = !!(displayExecution?.testFilePath || displayExecution?.implementationFilePath)

  // Determine output color based on status
  const outputColorClass = displayExecution
    ? getOutputColorClass(displayExecution.status)
    : "text-muted-foreground"

  return (
    <div
      data-testid="live-output-terminal-section"
      className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}
    >
      {/* Header */}
      <div
        data-testid="terminal-header"
        className={cn("flex items-center gap-2 mb-3", phaseColors.text)}
      >
        <Terminal className="h-4 w-4" />
        <h4 className="text-sm font-semibold">
          Output:{" "}
          {displayExecution
            ? getTaskName(displayExecution, platformFeatures)
            : "No execution selected"}
        </h4>
      </div>

      {/* Terminal Body */}
      <div
        data-testid="terminal-body"
        className="bg-black/80 rounded-md p-4 font-mono text-xs overflow-auto max-h-[400px]"
      >
        {!displayExecution ? (
          // Empty state - no execution selected
          <div
            data-testid="empty-state"
            className="text-muted-foreground text-center py-8"
          >
            Select an execution to view output...
          </div>
        ) : hasOutput ? (
          // Show output content
          <pre
            data-testid="terminal-output"
            className={cn("whitespace-pre-wrap break-words", outputColorClass)}
          >
            {outputContent}
          </pre>
        ) : (
          // No output available
          <div
            data-testid="no-output-message"
            className="text-muted-foreground text-center py-8"
          >
            No output available
          </div>
        )}
      </div>

      {/* File Paths Section */}
      {hasFilePaths && displayExecution && (
        <div
          data-testid="file-paths-section"
          className="mt-3 pt-3 border-t border-border space-y-1"
        >
          {displayExecution.testFilePath && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-red-400 font-semibold">TEST:</span>
              <span className="text-muted-foreground truncate">
                {displayExecution.testFilePath}
              </span>
            </div>
          )}
          {displayExecution.implementationFilePath && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-green-400 font-semibold">IMPL:</span>
              <span className="text-muted-foreground truncate">
                {displayExecution.implementationFilePath}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default LiveOutputTerminalSection
