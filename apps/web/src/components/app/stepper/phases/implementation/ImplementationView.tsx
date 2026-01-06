/**
 * ImplementationView Component
 * Task: task-2-3d-implementation-view
 *
 * Displays the Implementation phase content: run status and task executions.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/phases/implementation/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import {
  ExecutionProgress,
  TaskExecutionRow,
  type ImplementationRun,
  type TaskExecution,
} from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

/**
 * Feature type for ImplementationView
 */
export interface ImplementationFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for ImplementationView component
 */
export interface ImplementationViewProps {
  /** Feature session to display */
  feature: ImplementationFeature
}

/**
 * Task reference type for resolving names
 */
interface TaskRef {
  id: string
  name: string
}

/**
 * ImplementationView Component
 *
 * Displays implementation run status and task executions.
 * Shows ExecutionProgress at top, then list of TaskExecutionRow components.
 */
export const ImplementationView = observer(function ImplementationView({
  feature,
}: ImplementationViewProps) {
  // Access platform-features domain
  const { platformFeatures } = useDomains<{
    platformFeatures: {
      implementationTaskCollection: {
        findBySession: (sessionId: string) => TaskRef[]
        get: (id: string) => TaskRef | undefined
      }
      implementationRunCollection: {
        findLatestBySession: (sessionId: string) => ImplementationRun | undefined
      }
      taskExecutionCollection: {
        findByRun: (runId: string) => TaskExecution[]
      }
    }
  }>()

  // Fetch tasks for count
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []
  const totalTasks = tasks.length

  // Fetch latest run for this session
  const latestRun = platformFeatures?.implementationRunCollection?.findLatestBySession?.(feature.id)

  // Fetch executions for the run
  const executions = latestRun
    ? (platformFeatures?.taskExecutionCollection?.findByRun?.(latestRun.id) ?? [])
    : []

  // Sort executions by startedAt (most recent first)
  const sortedExecutions = [...executions].sort((a, b) => b.startedAt - a.startedAt)

  // Get current task name if run is in progress
  const currentTaskName = latestRun?.currentTaskId
    ? platformFeatures?.implementationTaskCollection?.get?.(latestRun.currentTaskId)?.name
    : undefined

  // Helper to get task name from execution
  const getTaskName = (execution: any): string => {
    // Try to get name from task reference
    if (execution.task?.name) {
      return execution.task.name
    }
    // Fallback to task ID lookup
    const taskId = typeof execution.task === "string" ? execution.task : execution.task?.id
    if (taskId) {
      const task = platformFeatures?.implementationTaskCollection?.get?.(taskId)
      return task?.name || "Unknown Task"
    }
    return "Unknown Task"
  }

  return (
    <div data-testid="implementation-view" className="space-y-6">
      {/* Run Status / Progress */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Implementation Run
        </h3>

        {latestRun ? (
          <ExecutionProgress
            run={latestRun}
            totalTasks={totalTasks}
            currentTaskName={currentTaskName}
          />
        ) : (
          <div className="p-4 bg-muted/30 rounded-lg">
            <p className="text-sm text-foreground">
              No implementation runs yet
            </p>
          </div>
        )}
      </section>

      {/* Task Executions */}
      {!latestRun ? (
        <EmptyPhaseContent
          phaseName="implementation"
          message="No implementation runs yet"
          description="Run the Implementation phase to start executing tasks."
        />
      ) : executions.length === 0 ? (
        <section className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No task executions recorded yet. Implementation will start shortly.
          </p>
        </section>
      ) : (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Task Executions ({executions.length})
          </h3>

          <div className="border rounded-lg divide-y">
            {sortedExecutions.map((execution: TaskExecution) => (
              <TaskExecutionRow
                key={execution.id}
                execution={execution}
                taskName={getTaskName(execution)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
})
