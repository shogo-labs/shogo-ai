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
 * Per Phase 2 conversion (schema-driven rendering):
 * - Uses PropertyRenderer for status badges via "task-status-badge" xRenderer
 * - Uses PropertyRenderer for acceptanceCriteria via "string-array" xRenderer
 */

import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { PropertyRenderer } from "@/components/rendering"
import type { PropertyMetadata } from "@/components/rendering/types"
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
 * PropertyMetadata for task status badge (resolved via registry)
 */
const statusPropertyMeta: PropertyMetadata = {
  name: "status",
  type: "string",
  enum: ["planned", "in_progress", "complete", "blocked"],
  xRenderer: "task-status-badge",
}

/**
 * PropertyMetadata for acceptance criteria (resolved via registry)
 */
const acceptanceCriteriaPropertyMeta: PropertyMetadata = {
  name: "acceptanceCriteria",
  type: "array",
  xRenderer: "string-array",
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
          <PropertyRenderer
            value={task.status}
            property={statusPropertyMeta}
          />
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Description */}
        <p className="text-sm text-muted-foreground line-clamp-2">
          {task.description}
        </p>

        {/* Acceptance Criteria (via PropertyRenderer) */}
        {hasCriteria && (
          <div className="border-t pt-3">
            <PropertyRenderer
              value={task.acceptanceCriteria}
              property={acceptanceCriteriaPropertyMeta}
              config={{
                size: "xs",
                layout: "compact",
                customProps: {
                  sectionLabel: "Acceptance Criteria",
                  collapsible: !defaultExpanded,
                },
              }}
            />
          </div>
        )}

        {/* Dependencies */}
        <DependencyIndicator dependencies={task.dependencies} />
      </CardContent>
    </Card>
  )
})
