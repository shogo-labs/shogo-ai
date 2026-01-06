/**
 * TaskRenderer - Entity-level renderer for ImplementationTask
 * Task: Phase 2 - Entity-Level Renderer
 *
 * Renders an entire ImplementationTask entity as a card, demonstrating
 * the rendering system works at multiple levels (property-level AND entity-level).
 *
 * Uses PropertyRenderer internally for the status badge (nested rendering).
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { PropertyRenderer } from "../../PropertyRenderer"
import { DependencyIndicator } from "@/components/app/stepper/cards/DependencyIndicator"
import type { DisplayRendererProps } from "../../types"

/**
 * The entity type we're rendering - ImplementationTask
 */
interface ImplementationTaskEntity {
  id: string
  name: string
  description: string
  status: string
  acceptanceCriteria: string[]
  dependencies?: Array<{ id: string; name: string }>
}

/**
 * TaskRenderer Component
 *
 * Entity-level renderer that renders an entire ImplementationTask as a card.
 * Uses PropertyRenderer internally for the status badge, demonstrating
 * nested rendering patterns.
 */
export const TaskRenderer = observer(function TaskRenderer({
  value,
}: DisplayRendererProps) {
  const task = value as ImplementationTaskEntity
  const [isExpanded, setIsExpanded] = useState(false)

  if (!task) {
    return <span className="text-muted-foreground">-</span>
  }

  const hasCriteria = task.acceptanceCriteria && task.acceptanceCriteria.length > 0

  return (
    <Card
      data-testid={`task-renderer-${task.id}`}
      data-renderer="implementation-task"
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
          {/* Use PropertyRenderer for the status badge - nested rendering! */}
          <PropertyRenderer
            value={task.status}
            property={{
              name: "status",
              type: "string",
              xRenderer: "task-status-badge",
            }}
          />
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
