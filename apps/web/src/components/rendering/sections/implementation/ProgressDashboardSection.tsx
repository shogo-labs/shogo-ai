/**
 * ProgressDashboardSection
 * Task: task-implementation-003
 *
 * Shows overall implementation progress with completion stats,
 * progress bar, and current task indicator.
 *
 * Displays:
 * - ProgressBar showing percentage completion
 * - 3-column grid: Completed (emerald), In Progress (amber), Failed (red)
 * - Current task name when latestRun.currentTaskId exists
 */

import React, { useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { cn } from "@/lib/utils"
import { Zap, Play } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ProgressBar } from "../../../app/stepper/primitives"
import type { SectionRendererProps } from "../../types"
import { useImplementationPanelContext } from "./ImplementationPanelContext"

/**
 * ProgressDashboardSection Component
 *
 * Displays overall implementation progress with stats.
 * Uses ProgressBar to show completion percentage.
 * Reads latestRun from context and fetches tasks from domain.
 */
export const ProgressDashboardSection = observer(function ProgressDashboardSection({
  feature,
  config,
}: SectionRendererProps) {
  const phaseColors = usePhaseColor("implementation")
  const { latestRun, sortedExecutions } = useImplementationPanelContext()
  const { platformFeatures } = useDomains()

  // Fetch tasks for count
  const tasks = useMemo(() => {
    return platformFeatures?.implementationTaskCollection?.findBySession?.(feature?.id) ?? []
  }, [platformFeatures, feature?.id])

  const totalTasks = tasks.length

  // Calculate completion stats from executions
  const completedTasks = useMemo(() => {
    return sortedExecutions.filter(
      (e) => e.status === "test_passing" || e.status === "complete"
    ).length
  }, [sortedExecutions])

  const failedTasks = useMemo(() => {
    return sortedExecutions.filter((e) => e.status === "failed").length
  }, [sortedExecutions])

  // Get current task name if run is in progress
  const currentTaskName = useMemo(() => {
    if (!latestRun?.currentTaskId) return null
    const task = platformFeatures?.implementationTaskCollection?.get?.(latestRun.currentTaskId)
    return task?.name ?? null
  }, [latestRun?.currentTaskId, platformFeatures])

  // In progress count (either from currentTaskId or executions with in_progress status)
  const inProgressCount = useMemo(() => {
    if (currentTaskName) return 1
    return sortedExecutions.filter((e) => e.status === "in_progress").length
  }, [currentTaskName, sortedExecutions])

  const percentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0

  return (
    <div
      data-testid="progress-dashboard-section"
      className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h4 className={cn("text-sm font-semibold flex items-center gap-2", phaseColors.text)}>
          <Zap className="h-4 w-4" />
          Execution Progress
        </h4>
        <span className="text-sm text-muted-foreground">
          {completedTasks}/{totalTasks} tasks
        </span>
      </div>

      {/* Progress Bar */}
      <ProgressBar
        value={percentage}
        max={100}
        className="h-3 mb-3"
        variant="default"
        data-testid="progress-bar"
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-4 text-center" data-testid="stats-grid">
        <div data-testid="completed-stat">
          <div className="text-2xl font-bold text-emerald-500">{completedTasks}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </div>
        <div data-testid="in-progress-stat">
          <div className="text-2xl font-bold text-amber-500">{inProgressCount}</div>
          <div className="text-xs text-muted-foreground">In Progress</div>
        </div>
        <div data-testid="failed-stat">
          <div className="text-2xl font-bold text-red-500">{failedTasks}</div>
          <div className="text-xs text-muted-foreground">Failed</div>
        </div>
      </div>

      {/* Current Task Indicator */}
      {currentTaskName && (
        <div className="mt-3 pt-3 border-t border-border" data-testid="current-task-indicator">
          <div className="flex items-center gap-2 text-sm">
            <Play className="h-3 w-3 text-amber-500 animate-pulse" />
            <span className="text-muted-foreground">Current:</span>
            <span className="text-foreground font-medium truncate">{currentTaskName}</span>
          </div>
        </div>
      )}
    </div>
  )
})

export default ProgressDashboardSection
