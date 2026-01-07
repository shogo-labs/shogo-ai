/**
 * GraphNode Component
 * Task: task-w1-graph-node-primitive
 *
 * A custom ReactFlow node component for displaying:
 * - entity: Schema entities in design visualizations
 * - task: Implementation tasks in dependency graphs
 * - phase: Phase nodes in journey visualizations
 */

import { memo } from "react"
import { cn } from "@/lib/utils"
import { phaseColorVariants, type PhaseType } from "@/components/rendering/displays/domain/variants"

/**
 * Node variant types
 */
export type GraphNodeVariant = "entity" | "task" | "phase"

/**
 * Status for task nodes
 */
export type TaskStatus = "planned" | "in_progress" | "complete" | "blocked"

/**
 * Node data interface (passed via ReactFlow data prop)
 */
export interface GraphNodeData {
  /** Display label */
  label: string
  /** Node variant */
  variant?: GraphNodeVariant
  /** Phase for phase-colored styling */
  phase?: PhaseType
  /** Status (for task variant) */
  status?: TaskStatus
  /** Optional description */
  description?: string
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/**
 * GraphNode component props (compatible with ReactFlow NodeProps)
 */
export interface GraphNodeProps {
  /** Unique node identifier */
  id: string
  /** Node data */
  data: GraphNodeData
  /** Whether the node is selected */
  selected?: boolean
  /** Whether the node is being dragged */
  dragging?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Get status-specific styling for task nodes
 */
function getStatusStyles(status: TaskStatus | undefined): string {
  switch (status) {
    case "complete":
      return "border-green-500/50 bg-green-500/10"
    case "in_progress":
      return "border-blue-500/50 bg-blue-500/10"
    case "blocked":
      return "border-red-500/50 bg-red-500/10"
    case "planned":
    default:
      return "border-muted-foreground/30 bg-muted/50"
  }
}

/**
 * Get variant-specific styling
 */
function getVariantStyles(variant: GraphNodeVariant | undefined): string {
  switch (variant) {
    case "entity":
      return "rounded-lg min-w-[120px]"
    case "phase":
      return "rounded-full min-w-[80px] aspect-square flex items-center justify-center"
    case "task":
    default:
      return "rounded-md min-w-[150px]"
  }
}

/**
 * Get phase border class when selected
 */
function getPhaseBorderClass(phase: PhaseType | undefined, selected: boolean): string {
  if (!selected || !phase) return ""
  return phaseColorVariants({ phase, variant: "border" })
}

/**
 * Connection handle component
 */
function Handle({
  type,
  position,
}: {
  type: "source" | "target"
  position: "left" | "right"
}) {
  return (
    <div
      data-handle-type={type}
      data-handle-position={position}
      className={cn(
        "absolute w-3 h-3 rounded-full",
        "bg-muted-foreground/50 border-2 border-background",
        "hover:bg-primary hover:scale-110",
        "transition-all duration-150",
        position === "left" ? "-left-1.5 top-1/2 -translate-y-1/2" : "-right-1.5 top-1/2 -translate-y-1/2"
      )}
    />
  )
}

/**
 * GraphNode component
 *
 * @example
 * ```tsx
 * // Task node for dependency graph
 * <GraphNode
 *   id="task-001"
 *   data={{
 *     label: "Create interfaces",
 *     variant: "task",
 *     status: "complete",
 *   }}
 * />
 *
 * // Phase node for journey visualization
 * <GraphNode
 *   id="phase-discovery"
 *   data={{
 *     label: "Discovery",
 *     variant: "phase",
 *     phase: "discovery",
 *   }}
 * />
 *
 * // Entity node for schema visualization
 * <GraphNode
 *   id="entity-user"
 *   data={{
 *     label: "User",
 *     variant: "entity",
 *   }}
 * />
 * ```
 */
export const GraphNode = memo(function GraphNode({
  id,
  data,
  selected = false,
  dragging = false,
  className,
}: GraphNodeProps) {
  const { label, variant = "task", phase, status, description } = data

  const baseClasses = cn(
    "relative px-4 py-3",
    "border-2 bg-card shadow-sm",
    "transition-all duration-200",
    "hover:shadow-md hover:scale-[1.02]",
    getVariantStyles(variant),
    variant === "task" && getStatusStyles(status),
    selected && "ring-2 ring-primary ring-offset-2",
    selected && phase && getPhaseBorderClass(phase, true),
    dragging && "opacity-70 scale-105",
    className
  )

  return (
    <div
      data-graph-node
      data-node-id={id}
      data-variant={variant}
      data-phase={phase}
      data-selected={selected}
      className={baseClasses}
    >
      {/* Target handle (left) */}
      <Handle type="target" position="left" />

      {/* Node content */}
      <div className={cn(
        "text-center",
        variant === "phase" && "flex flex-col items-center justify-center"
      )}>
        <div className="font-medium text-sm text-foreground truncate max-w-[180px]">
          {label}
        </div>
        {description && variant !== "phase" && (
          <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {description}
          </div>
        )}
        {status && variant === "task" && (
          <div className="mt-2">
            <StatusBadge status={status} />
          </div>
        )}
      </div>

      {/* Source handle (right) */}
      <Handle type="source" position="right" />
    </div>
  )
})

/**
 * Status badge for task nodes
 */
function StatusBadge({ status }: { status: TaskStatus }) {
  const statusConfig: Record<TaskStatus, { label: string; className: string }> = {
    planned: { label: "Planned", className: "bg-muted text-muted-foreground" },
    in_progress: { label: "In Progress", className: "bg-blue-500/20 text-blue-700 dark:text-blue-300" },
    complete: { label: "Complete", className: "bg-green-500/20 text-green-700 dark:text-green-300" },
    blocked: { label: "Blocked", className: "bg-red-500/20 text-red-700 dark:text-red-300" },
  }

  const config = statusConfig[status]

  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
        config.className
      )}
    >
      {config.label}
    </span>
  )
}
