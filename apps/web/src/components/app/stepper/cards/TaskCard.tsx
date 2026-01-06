/**
 * TaskCard Component
 * Task: task-2-3d-task-card
 *
 * Displays a single ImplementationTask entity with status badge,
 * acceptance criteria, and dependency indicators.
 *
 * Props:
 * - task: ImplementationTask object with id, name, description, status, acceptanceCriteria, dependencies
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/cards/
 * - Uses useDomains() for data access (via parent)
 * - Wrapped with observer() for MobX reactivity
 *
 * Per finding-2-3d-002 (CVA pattern):
 * - Uses taskStatusVariants CVA for status badges
 *   - planned: gray
 *   - in_progress: blue
 *   - complete: green
 *   - blocked: red
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { cva, type VariantProps } from "class-variance-authority"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { DependencyIndicator } from "./DependencyIndicator"

/**
 * Task status type - matches ImplementationTask entity
 */
export type TaskStatus = "planned" | "in_progress" | "complete" | "blocked"

/**
 * ImplementationTask type for card display
 */
export interface Task {
  id: string
  name: string
  description: string
  status: TaskStatus
  acceptanceCriteria: string[]
  dependencies?: Task[]
}

/**
 * Props for TaskCard component
 */
export interface TaskCardProps {
  /** Task to display */
  task: Task
  /** Whether criteria list is expanded by default */
  defaultExpanded?: boolean
}

/**
 * CVA variants for task status badge styling
 * Maps task status to visual styling
 */
export const taskStatusVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        planned: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
        in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        complete: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
        blocked: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      },
    },
    defaultVariants: {
      status: "planned",
    },
  }
)

/**
 * Get display label for task status
 */
function getStatusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    planned: "Planned",
    in_progress: "In Progress",
    complete: "Complete",
    blocked: "Blocked",
  }
  return labels[status] || status
}

/**
 * TaskCard Component
 *
 * Renders a single implementation task with:
 * - Task name and status badge in header
 * - Description text
 * - Expandable/collapsible acceptance criteria list
 * - Dependency indicator showing prerequisite tasks
 */
export const TaskCard = observer(function TaskCard({
  task,
  defaultExpanded = false,
}: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const statusKey = task.status as VariantProps<typeof taskStatusVariants>["status"]

  const hasCriteria = task.acceptanceCriteria && task.acceptanceCriteria.length > 0

  return (
    <Card
      data-testid={`task-card-${task.id}`}
      className={cn(
        "transition-all",
        "hover:shadow-md hover:border-primary/50"
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-foreground truncate">
              {task.name}
            </h4>
          </div>
          <span className={taskStatusVariants({ status: statusKey })}>
            {getStatusLabel(task.status)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Description */}
        <p className="text-sm text-muted-foreground line-clamp-2">
          {task.description}
        </p>

        {/* Acceptance Criteria (collapsible) */}
        {hasCriteria && (
          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Acceptance Criteria ({task.acceptanceCriteria.length})
            </button>

            {isExpanded && (
              <ul className="mt-2 space-y-1 pl-5">
                {task.acceptanceCriteria.map((criterion, index) => (
                  <li
                    key={index}
                    className="text-xs text-muted-foreground list-disc"
                  >
                    {criterion}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Dependencies */}
        <DependencyIndicator dependencies={task.dependencies} />
      </CardContent>
    </Card>
  )
})
