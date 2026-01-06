/**
 * TestingView Component
 * Task: task-2-3d-testing-view
 *
 * Displays the Testing phase content: test specifications grouped by parent task.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/phases/testing/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { TestSpecCard, type TestSpec } from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

/**
 * Feature type for TestingView
 */
export interface TestingFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for TestingView component
 */
export interface TestingViewProps {
  /** Feature session to display */
  feature: TestingFeature
}

/**
 * Task type with test specs
 */
interface TaskWithSpecs {
  id: string
  name: string
  specs: TestSpec[]
}

/**
 * TestingView Component
 *
 * Displays test specifications for the selected feature session.
 * Specs are grouped by parent task with task name as section header.
 */
export const TestingView = observer(function TestingView({
  feature,
}: TestingViewProps) {
  // Access platform-features domain for tasks and specs
  const { platformFeatures } = useDomains<{
    platformFeatures: {
      implementationTaskCollection: {
        findBySession: (sessionId: string) => Array<{ id: string; name: string }>
      }
      testSpecificationCollection: {
        findByTask: (taskId: string) => TestSpec[]
      }
    }
  }>()

  // Fetch tasks for this feature session
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []

  // Build task-to-specs mapping
  const tasksWithSpecs: TaskWithSpecs[] = tasks.map((task: any) => ({
    id: task.id,
    name: task.name,
    specs: platformFeatures?.testSpecificationCollection?.findByTask?.(task.id) ?? [],
  })).filter((t: TaskWithSpecs) => t.specs.length > 0)

  // Count total specs
  const totalSpecs = tasksWithSpecs.reduce((sum, t) => sum + t.specs.length, 0)
  const tasksWithSpecsCount = tasksWithSpecs.length

  return (
    <div data-testid="testing-view" className="space-y-6">
      {/* Coverage Summary */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Test Coverage Summary
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg">
          <p className="text-sm text-foreground">
            {totalSpecs === 0 ? (
              "No test specifications generated yet"
            ) : (
              `${totalSpecs} test specification${totalSpecs !== 1 ? "s" : ""} for ${tasksWithSpecsCount} task${tasksWithSpecsCount !== 1 ? "s" : ""}`
            )}
          </p>
        </div>
      </section>

      {/* Test Specifications by Task */}
      {totalSpecs === 0 ? (
        <EmptyPhaseContent
          phaseName="testing"
          message="No test specifications generated"
          description="Run the Testing phase to generate test specifications from implementation tasks."
        />
      ) : (
        <div className="space-y-6">
          {tasksWithSpecs.map((taskWithSpecs) => (
            <section key={taskWithSpecs.id}>
              {/* Task header */}
              <div className="flex items-center gap-2 mb-3">
                <h4 className="font-medium text-foreground">
                  {taskWithSpecs.name}
                </h4>
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {taskWithSpecs.specs.length} spec{taskWithSpecs.specs.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Test specs for this task */}
              <div className="space-y-3 pl-4 border-l-2 border-muted">
                {taskWithSpecs.specs.map((spec: TestSpec) => (
                  <TestSpecCard key={spec.id} spec={spec} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
})
