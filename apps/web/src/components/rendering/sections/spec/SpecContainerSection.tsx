/**
 * SpecContainerSection
 * Task: task-spec-001, task-spec-002, task-spec-007
 *
 * Container section for Spec phase with ReactFlow-based Task Dependency Network.
 * Demonstrates the container section pattern for complex phases with
 * tightly-coupled interactive elements (graph + details panel).
 *
 * Internal sub-components (defined in this file, NOT registered separately):
 * - TaskNode: Custom ReactFlow node for tasks (task-spec-002)
 *
 * External sub-components (imported as local dependencies):
 * - TaskDetailsPanel: Side panel for selected task details (task-spec-005)
 * - graphUtils: transformToGraph for graph transformation (task-spec-006)
 *
 * Container Pattern Rules:
 * - Internal state (selectedTaskId) uses React useState
 * - Sub-components are NOT registered in sectionImplementationMap
 * - All sub-components are defined inside this file or as local imports
 *
 * @see CONTAINER_SECTION_PATTERN.md for pattern documentation
 */

import { useState, useMemo, useCallback, memo } from "react"
import { observer } from "mobx-react-lite"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  GitBranch,
  Circle,
  Clock,
  CheckCircle,
  AlertCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { useDomains } from "@/contexts/DomainProvider"
import { EmptyPhaseContent } from "@/components/app/stepper/EmptyStates"
import type { SectionRendererProps } from "../../types"
import { TaskDetailsPanel, type Task as TaskDetailTask } from "./TaskDetailsPanel"
import { transformToGraph, type Task, type TaskNodeData } from "./graphUtils"

// =============================================================================
// TaskNode Sub-component
// Task: task-spec-002
// =============================================================================

/**
 * Status icon mapping
 * Maps task status to corresponding Lucide icon with appropriate styling
 */
const statusIcons: Record<string, React.ReactNode> = {
  planned: <Circle className="h-3 w-3 text-muted-foreground" />,
  in_progress: <Clock className="h-3 w-3 text-blue-500 animate-pulse" />,
  complete: <CheckCircle className="h-3 w-3 text-emerald-500" />,
  blocked: <AlertCircle className="h-3 w-3 text-red-500" />,
}

/**
 * TaskNode Component
 * Task: task-spec-002
 *
 * Custom ReactFlow node for tasks with status and dependency info.
 * Wrapped with React.memo for ReactFlow performance optimization.
 *
 * Features:
 * - Handle components for left (target) and right (source) positions
 * - Status icons: Circle (planned), Clock+animate-pulse (in_progress),
 *   CheckCircle (complete), AlertCircle (blocked)
 * - Selection styling: border-emerald-500 ring-2 ring-emerald-500/30 shadow-lg when isSelected
 * - Critical path styling: border-emerald-500/60 when isCritical but not selected
 * - Default styling: border-emerald-500/30 hover:border-emerald-500/50
 * - Shows dependencyCount and blocksCount with emerald text color
 */
const TaskNode = memo(function TaskNode({ data }: NodeProps) {
  const { task, dependencyCount, blocksCount, isSelected, isCritical } = data as unknown as TaskNodeData

  return (
    <div
      className={cn(
        "px-4 py-3 rounded-lg min-w-[200px] transition-all",
        "bg-card border-2",
        isSelected
          ? "border-emerald-500 ring-2 ring-emerald-500/30 shadow-lg"
          : isCritical
            ? "border-emerald-500/60"
            : "border-emerald-500/30 hover:border-emerald-500/50"
      )}
    >
      {/* Target handle - left side for incoming edges */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-emerald-500 !border-background !w-3 !h-3"
      />

      {/* Task header with status icon and name */}
      <div className="flex items-center gap-2 mb-2">
        {statusIcons[task.status] || statusIcons.planned}
        <span className="font-medium text-sm text-foreground truncate">
          {task.name}
        </span>
      </div>

      {/* Dependency and blocks counts */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="text-emerald-500">{dependencyCount}</span>
          <span>deps</span>
        </span>
        <span className="text-emerald-500/40">|</span>
        <span className="flex items-center gap-1">
          <span className="text-emerald-500">{blocksCount}</span>
          <span>blocks</span>
        </span>
      </div>

      {/* Source handle - right side for outgoing edges */}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-emerald-500 !border-background !w-3 !h-3"
      />
    </div>
  )
})

// =============================================================================
// nodeTypes registry
// =============================================================================

/**
 * nodeTypes object for ReactFlow
 * Registers the taskNode type to use TaskNode component
 */
const nodeTypes = {
  taskNode: TaskNode,
}

// =============================================================================
// Main Container Section Component
// =============================================================================

/**
 * SpecContainerSection - Container section for Spec phase
 * Task: task-spec-001, task-spec-007
 *
 * Features:
 * - Header with GitBranch icon and "Task Dependency Network" title
 * - Task count badge with proper pluralization
 * - Full height flex layout (h-full flex flex-col overflow-hidden)
 * - selectedTaskId state managed via React useState
 * - Wrapped with observer() for MobX domain reactivity
 * - Emerald phase colors throughout (spec phase)
 * - ReactFlow graph with task dependency visualization
 * - TaskDetailsPanel for selected task information
 * - Empty state handling via EmptyPhaseContent
 *
 * @param feature - The current FeatureSession data
 * @param config - Optional configuration from slotContent
 */
export const SpecContainerSection = observer(function SpecContainerSection({
  feature,
  config,
}: SectionRendererProps) {
  // Get spec phase colors for consistent styling (emerald)
  const phaseColors = usePhaseColor("spec")

  // Internal state for task selection (Container Section Pattern)
  // This state is managed internally via useState, NOT Wavesmith stores
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // Access platform-features domain for tasks and integration points
  const { platformFeatures } = useDomains()

  // Fetch tasks for this feature session
  const tasks: Task[] = platformFeatures?.implementationTaskCollection?.findBySession?.(feature?.id) ?? []
  const taskCount = tasks.length

  // Fetch integration points for this feature session
  const integrationPoints = platformFeatures?.integrationPointCollection?.findBySession?.(feature?.id) ?? []

  // Memoize graph transformation to avoid recalculation on re-renders
  const { nodes, edges } = useMemo(
    () => transformToGraph(tasks, selectedTaskId),
    [tasks, selectedTaskId]
  )

  // Memoize selected task lookup from tasks array
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  )

  // onNodeClick callback toggles selection (same node = deselect, different = select)
  const handleNodeClick = useCallback(
    (_: any, node: Node) => {
      const nodeId = node.id
      setSelectedTaskId((current) => (nodeId === current ? null : nodeId))
    },
    []
  )

  // handleCloseDetails callback sets selectedTaskId to null
  const handleCloseDetails = useCallback(() => {
    setSelectedTaskId(null)
  }, [])

  return (
    <div
      data-testid="spec-container-section"
      className="h-full flex flex-col overflow-hidden"
    >
      {/* Header section with phase-colored styling */}
      <div className={cn("flex items-center gap-2 pb-3 mb-3 border-b min-w-0", phaseColors.border)}>
        <GitBranch className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Task Dependency Network
        </h2>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          ({taskCount} task{taskCount !== 1 ? "s" : ""})
        </span>
      </div>

      {/* Empty state when no tasks */}
      {taskCount === 0 ? (
        <EmptyPhaseContent
          phaseName="spec"
        />
      ) : (
        /* Main content area - ReactFlow graph and details panel */
        <div className="flex-1 flex min-h-0">
          {/* Graph container */}
          <div
            className={cn(
              "flex-1 rounded-lg overflow-hidden border",
              "border-emerald-500/20 bg-emerald-500/5"
            )}
          >
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes as unknown as Node[]}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={handleNodeClick}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.5}
                maxZoom={1.5}
              >
                <Background color="#10b98110" gap={20} />
                <Controls />
              </ReactFlow>
            </ReactFlowProvider>
          </div>

          {/* Task details panel - visible when a task is selected */}
          <TaskDetailsPanel
            task={selectedTask as TaskDetailTask | null}
            integrationPoints={integrationPoints}
            onClose={handleCloseDetails}
          />
        </div>
      )}
    </div>
  )
})
