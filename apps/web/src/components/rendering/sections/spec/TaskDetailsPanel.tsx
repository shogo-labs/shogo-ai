/**
 * TaskDetailsPanel - Internal sub-component for SpecContainerSection
 * Task: task-spec-005
 *
 * Displays selected task details with:
 * - Header: task name + close button (X icon)
 * - Status section via PropertyRenderer with task-status-badge renderer
 * - Description section (conditional, when task.description exists)
 * - Acceptance criteria via PropertyRenderer with string-array renderer
 * - IntegrationPointsSection with filtered integration points (ip.task === task.id)
 * - Dependencies section with emerald-colored badges
 *
 * Panel styling: w-80 border-l border-emerald-500/20 bg-card p-4 overflow-auto
 *
 * This is an INTERNAL sub-component - NOT registered in sectionImplementationMap.
 * Used by SpecContainerSection when a task is selected.
 */

import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { PropertyRenderer } from "@/components/rendering"
import type { PropertyMetadata } from "@/components/rendering"
import { IntegrationPointsSection } from "./IntegrationPointsSection"
import type { IntegrationPoint } from "./IntegrationPointCard"

// =============================================================================
// Types
// =============================================================================

/**
 * Task interface for implementation tasks
 * Task: task-spec-005
 *
 * Minimal interface for TaskDetailsPanel rendering.
 * Matches the ImplementationTask entity structure.
 */
export interface Task {
  id: string
  name: string
  status: string
  description?: string
  acceptanceCriteria: string[]
  dependencies: string[]
}

/**
 * IntegrationPoint with task reference for filtering
 * Extends the base IntegrationPoint with the task field
 */
interface IntegrationPointWithTask extends IntegrationPoint {
  task?: string
}

/**
 * Props for TaskDetailsPanel component
 * Task: task-spec-005
 */
export interface TaskDetailsPanelProps {
  /** The selected task to display, or null if no task selected */
  task: Task | null
  /** All integration points (will be filtered by task.id) */
  integrationPoints: IntegrationPointWithTask[]
  /** Callback to close the panel */
  onClose: () => void
}

// =============================================================================
// PropertyMetadata definitions for PropertyRenderer
// =============================================================================

/**
 * PropertyMetadata for status field
 * Uses task-status-badge renderer for semantic status display
 */
const statusPropertyMeta: PropertyMetadata = {
  name: "status",
  type: "string",
  xRenderer: "task-status-badge",
}

/**
 * PropertyMetadata for acceptanceCriteria field
 * Uses string-array renderer for list display
 */
const acceptanceCriteriaPropertyMeta: PropertyMetadata = {
  name: "acceptanceCriteria",
  type: "array",
  xRenderer: "string-array",
}

// =============================================================================
// TaskDetailsPanel Component
// =============================================================================

/**
 * TaskDetailsPanel - displays selected task details
 * Task: task-spec-005
 *
 * Features:
 * - Returns null when task is null
 * - Header with task name and X close button
 * - Status section using PropertyRenderer (task-status-badge)
 * - Description section (conditional)
 * - Acceptance criteria using PropertyRenderer (string-array)
 * - IntegrationPointsSection with filtered points
 * - Dependencies as emerald-colored badges
 *
 * @param task - The selected task, or null
 * @param integrationPoints - All integration points (will be filtered)
 * @param onClose - Callback to close the panel
 */
export function TaskDetailsPanel({
  task,
  integrationPoints,
  onClose,
}: TaskDetailsPanelProps) {
  // Return null when no task is selected
  if (!task) {
    return null
  }

  // Filter integration points for this task
  const filteredIntegrationPoints = integrationPoints.filter(
    (ip) => ip.task === task.id
  )

  return (
    <div
      className={cn(
        "w-80 border-l border-emerald-500/20 bg-card p-4 overflow-auto"
      )}
    >
      {/* Header with task name and close button */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-foreground truncate pr-2">
          {task.name}
        </h3>
        <button
          onClick={onClose}
          className={cn(
            "p-1 rounded hover:bg-emerald-500/10 transition-colors",
            "text-muted-foreground hover:text-foreground"
          )}
          aria-label="Close task details"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Status section */}
      <div className="mb-4">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground block mb-1">
          Status
        </span>
        <PropertyRenderer
          property={statusPropertyMeta}
          value={task.status}
        />
      </div>

      {/* Description section (conditional) */}
      {task.description && (
        <div className="mb-4">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground block mb-1">
            Description
          </span>
          <p className="text-sm text-foreground">
            {task.description}
          </p>
        </div>
      )}

      {/* Acceptance criteria section */}
      {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
        <div className="mb-4">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground block mb-1">
            Acceptance Criteria
          </span>
          <PropertyRenderer
            property={acceptanceCriteriaPropertyMeta}
            value={task.acceptanceCriteria}
          />
        </div>
      )}

      {/* Integration points section */}
      <div className="mb-4">
        <IntegrationPointsSection
          integrationPoints={filteredIntegrationPoints}
        />
      </div>

      {/* Dependencies section */}
      {task.dependencies && task.dependencies.length > 0 && (
        <div className="mb-4">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground block mb-1">
            Dependencies
          </span>
          <div className="flex flex-wrap gap-2">
            {task.dependencies.map((dep) => (
              <span
                key={dep}
                className={cn(
                  "px-2 py-1 rounded text-xs font-medium",
                  "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                )}
              >
                {dep}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default TaskDetailsPanel
