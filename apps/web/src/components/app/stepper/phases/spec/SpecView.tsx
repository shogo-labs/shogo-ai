/**
 * SpecView Component
 * Task: task-2-3d-spec-view
 *
 * Displays the Spec phase content: implementation tasks with dependencies.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/phases/spec/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { TaskCard, type Task } from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

/**
 * Feature type for SpecView
 */
export interface SpecFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for SpecView component
 */
export interface SpecViewProps {
  /** Feature session to display */
  feature: SpecFeature
}

/**
 * Sort tasks by dependency order (tasks with no dependencies first)
 */
function sortByDependencyOrder(tasks: Task[]): Task[] {
  // Simple topological sort - tasks with fewer dependencies come first
  return [...tasks].sort((a, b) => {
    const aDeps = a.dependencies?.length || 0
    const bDeps = b.dependencies?.length || 0
    return aDeps - bDeps
  })
}

/**
 * SpecView Component
 *
 * Displays implementation tasks for the selected feature session.
 * Tasks are sorted by dependency order (no dependencies first).
 */
export const SpecView = observer(function SpecView({
  feature,
}: SpecViewProps) {
  // Access platform-features domain for tasks
  const { platformFeatures } = useDomains<{
    platformFeatures: {
      implementationTaskCollection: {
        findBySession: (sessionId: string) => Task[]
      }
    }
  }>()

  // Fetch tasks for this feature session
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []

  // Sort tasks by dependency order
  const sortedTasks = sortByDependencyOrder(tasks)

  return (
    <div data-testid="spec-view" className="space-y-4">
      {/* Summary */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Implementation Tasks
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg">
          <p className="text-sm text-foreground">
            {tasks.length === 0 ? (
              "No implementation tasks defined yet"
            ) : (
              `${tasks.length} task${tasks.length !== 1 ? "s" : ""} defined`
            )}
          </p>
        </div>
      </section>

      {/* Tasks list */}
      {tasks.length === 0 ? (
        <EmptyPhaseContent
          phaseName="spec"
          message="No implementation tasks defined"
          description="Run the Spec phase to generate implementation tasks from requirements."
        />
      ) : (
        <div className="space-y-4">
          {sortedTasks.map((task: Task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  )
})
