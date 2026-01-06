/**
 * DependencyIndicator Component
 * Task: task-2-3d-dependency-indicator
 *
 * Displays task dependencies as inline list with status dots.
 * Shows dependency task names with colored status indicators.
 *
 * Props:
 * - dependencies: Array of ImplementationTask references
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/cards/
 * - Wrapped with observer() for MobX reactivity
 *
 * Status dot colors:
 * - green: complete
 * - gray: planned
 * - blue: in_progress
 * - red: blocked
 */

import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"

/**
 * Dependency task type (subset of ImplementationTask)
 */
export interface DependencyTask {
  id: string
  name: string
  status: "planned" | "in_progress" | "complete" | "blocked"
}

/**
 * Props for DependencyIndicator component
 */
export interface DependencyIndicatorProps {
  /** Array of dependency tasks to display */
  dependencies?: DependencyTask[]
}

/**
 * Get status dot color class based on task status
 */
function getStatusDotColor(status: string): string {
  switch (status) {
    case "complete":
      return "bg-green-500"
    case "in_progress":
      return "bg-blue-500"
    case "blocked":
      return "bg-red-500"
    case "planned":
    default:
      return "bg-gray-400"
  }
}

/**
 * DependencyIndicator Component
 *
 * Renders dependency task names with status indicator dots.
 * Returns null if no dependencies exist.
 */
export const DependencyIndicator = observer(function DependencyIndicator({
  dependencies,
}: DependencyIndicatorProps) {
  // Return null if no dependencies
  if (!dependencies || dependencies.length === 0) {
    return null
  }

  return (
    <div
      data-testid="dependency-indicator"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      <span className="font-medium">Depends on:</span>
      {dependencies.map((dep) => (
        <span
          key={dep.id}
          className="inline-flex items-center gap-1"
          title={`${dep.name} - ${dep.status}`}
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              getStatusDotColor(dep.status)
            )}
          />
          <span className="truncate max-w-[120px]">{dep.name}</span>
        </span>
      ))}
    </div>
  )
})
