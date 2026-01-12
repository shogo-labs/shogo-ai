/**
 * TaskCoverageBarSection
 * Task: task-testing-004
 *
 * Displays per-task test coverage with ProgressBar and clickable spec dots for selection.
 * Part of the composable Testing phase view.
 *
 * Features:
 * - Fetches tasks from platformFeatures.implementationTaskCollection.findBySession(feature.id)
 * - For each task, fetches specs from platformFeatures.testSpecificationCollection.findByTask(task.id)
 * - Uses useTestingPanelContext to get setSelectedSpec function
 * - Renders Target icon (h-4 w-4) with 'Task Coverage' title in phaseColors.text
 * - Each task row shows: task name (truncated max-w-[200px]), spec count, ProgressBar, clickable dots
 * - ProgressBar uses coverage = (task.specs.length / maxSpecs) * 100 with variant='default' className='h-2 flex-1'
 * - Clickable dots: button with w-2 h-2 rounded-full bg-cyan-500 hover:bg-cyan-400 styling
 * - Shows max 5 dots per task with '+N' overflow indicator when specs.length > 5
 * - Clicking dot calls setSelectedSpec(spec) from context
 * - Each dot has title={spec.scenario} for tooltip
 * - Container uses p-4 rounded-lg border bg-card phaseColors.border styling
 * - Filters out tasks with zero specs from display
 */

import { observer } from "mobx-react-lite"
import { useMemo, useCallback } from "react"
import { Target } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ProgressBar } from "@/components/rendering/displays/visualization/ProgressBar"
import {
  SectionCard,
  SectionHeader,
  EmptySectionState,
} from "../shared"
import { useTestingPanelContext, type TestSpec } from "./TestingPanelContext"
import type { SectionRendererProps } from "../../types"

/**
 * Maximum number of spec dots to display per task row
 */
const MAX_VISIBLE_DOTS = 5

/**
 * TaskCoverageBarSection - Per-task test coverage with interactive spec dots
 *
 * Shows each implementation task with:
 * - Task name (truncated)
 * - Spec count
 * - Coverage progress bar
 * - Clickable dots for each spec (max 5, with overflow indicator)
 */
export const TaskCoverageBarSection = observer(function TaskCoverageBarSection({
  feature,
  config,
}: SectionRendererProps) {
  // Get testing phase colors (cyan theme)
  const phaseColors = usePhaseColor("testing")

  // Access platform-features domain for tasks and specs
  const { platformFeatures } = useDomains()

  // Get setSelectedSpec from context
  const { setSelectedSpec } = useTestingPanelContext()

  // Get tasks for this feature session
  const tasks = useMemo(() => {
    if (!platformFeatures?.implementationTaskCollection) return []
    return platformFeatures.implementationTaskCollection
      .all()
      .filter((t: any) => t.session?.id === feature?.id)
  }, [platformFeatures, feature?.id])

  // Get task IDs for filtering specs
  const taskIds = useMemo(() => new Set(tasks.map((t: any) => t.id)), [tasks])

  // Get all specs for tasks belonging to this feature
  const allSpecs = useMemo(() => {
    if (!platformFeatures?.testSpecificationCollection) return []
    return platformFeatures.testSpecificationCollection
      .all()
      .filter((s: any) => taskIds.has(s.task?.id))
  }, [platformFeatures, taskIds])

  // Group specs by task ID
  const specsByTask = useMemo(() => {
    const map = new Map<string, any[]>()
    allSpecs.forEach((spec: any) => {
      const taskId = spec.task?.id
      if (taskId) {
        const existing = map.get(taskId) || []
        existing.push(spec)
        map.set(taskId, existing)
      }
    })
    return map
  }, [allSpecs])

  // Tasks with their specs, filtered to only those with specs
  const tasksWithSpecs = useMemo(() => {
    return tasks
      .map((task: any) => ({
        task,
        specs: specsByTask.get(task.id) || [],
      }))
      .filter(({ specs }) => specs.length > 0)
  }, [tasks, specsByTask])

  // Calculate max specs for progress bar scaling
  const maxSpecs = useMemo(() => {
    if (tasksWithSpecs.length === 0) return 1
    return Math.max(...tasksWithSpecs.map(({ specs }) => specs.length), 1)
  }, [tasksWithSpecs])

  // Handle spec dot click
  const handleSpecClick = useCallback(
    (spec: any) => {
      setSelectedSpec(spec as TestSpec)
    },
    [setSelectedSpec]
  )

  return (
    <SectionCard
      phaseColors={phaseColors}
      testId="task-coverage-bar-section"
    >
      <SectionHeader
        icon={<Target className="h-4 w-4" />}
        title="Task Coverage"
        phaseColors={phaseColors}
      />

      <div className="mt-4 space-y-3">
        {tasksWithSpecs.length === 0 ? (
          <EmptySectionState
            icon={Target}
            message="No tasks with test specifications found"
          />
        ) : (
          tasksWithSpecs.map(({ task, specs }) => {
            const coverage = (specs.length / maxSpecs) * 100
            const visibleSpecs = specs.slice(0, MAX_VISIBLE_DOTS)
            const overflowCount = specs.length - MAX_VISIBLE_DOTS

            return (
              <div
                key={task.id}
                data-testid="task-row"
                className="space-y-2"
              >
                {/* Task info row */}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      data-testid="task-name"
                      className="text-sm font-medium truncate max-w-[200px]"
                      title={task.name}
                    >
                      {task.name}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {specs.length} specs
                    </span>
                  </div>

                  {/* Spec dots */}
                  <div className="flex items-center gap-1">
                    {visibleSpecs.map((spec: any) => (
                      <button
                        key={spec.id}
                        data-testid="spec-dot"
                        type="button"
                        title={spec.scenario}
                        onClick={() => handleSpecClick(spec)}
                        className={cn(
                          "w-2 h-2 rounded-full",
                          "bg-cyan-500 hover:bg-cyan-400",
                          "transition-colors cursor-pointer",
                          "focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-1"
                        )}
                        aria-label={`View spec: ${spec.scenario}`}
                      />
                    ))}
                    {overflowCount > 0 && (
                      <span
                        data-testid="overflow-indicator"
                        className="text-xs text-muted-foreground ml-1"
                      >
                        +{overflowCount}
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar row */}
                <ProgressBar
                  value={coverage}
                  max={100}
                  variant="horizontal"
                  phase="testing"
                  className="h-2 flex-1"
                  ariaLabel={`${task.name} coverage: ${specs.length} of ${maxSpecs} specs`}
                />
              </div>
            )
          })
        )}
      </div>
    </SectionCard>
  )
})

export default TaskCoverageBarSection
