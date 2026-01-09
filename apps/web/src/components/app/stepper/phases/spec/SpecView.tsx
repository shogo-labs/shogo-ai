/**
 * SpecView Component - Redesigned
 * Task: task-w2-spec-view-redesign
 *
 * "Task Dependency Network" aesthetic with:
 * - TaskDependencyGraph: ReactFlow-based horizontal layered layout
 * - TaskNode: Shows status, dependency count, blocks count
 * - CriticalPathHighlighter: Emphasizes longest dependency chain
 * - Task details panel on selection
 *
 * Uses phase-spec color tokens (emerald) throughout.
 */

import { useState, useMemo, useCallback, memo } from "react"
import { observer } from "mobx-react-lite"
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { GitBranch, CheckCircle, Clock, AlertCircle, X, Circle, Link2 } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { PropertyRenderer } from "@/components/rendering"
import type { PropertyMetadata } from "@/components/rendering/types"
import { type Task } from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

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
 * PropertyMetadata for IntegrationPoint.changeType (resolved via registry)
 * Task: task-cbe-007
 *
 * Semantic colors: add=green, modify=blue, extend=purple, remove=red
 */
const changeTypeMeta: PropertyMetadata = {
  name: "changeType",
  type: "string",
  enum: ["add", "modify", "extend", "remove"],
  xRenderer: "change-type-badge",
}

/**
 * PropertyMetadata for IntegrationPoint.filePath (resolved via registry)
 * Task: task-cbe-007
 *
 * Displays with monospace styling via CodePathDisplay
 */
const filePathMeta: PropertyMetadata = {
  name: "filePath",
  type: "string",
  xRenderer: "code-path",
}

/**
 * PropertyMetadata for IntegrationPoint.description (resolved via registry)
 * Task: task-cbe-007
 *
 * Shows expand/collapse for long content via LongTextDisplay
 */
const integrationPointDescriptionMeta: PropertyMetadata = {
  name: "description",
  type: "string",
  xRenderer: "long-text",
}

/**
 * IntegrationPoint type for SpecView
 * Task: task-cbe-007
 */
export interface IntegrationPoint {
  id: string
  name: string
  filePath: string
  changeType?: string
  description: string
  package?: string
  targetFunction?: string
}

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
 * Task node data for ReactFlow
 */
interface TaskNodeData {
  task: Task
  dependencyCount: number
  blocksCount: number
  isSelected: boolean
  isCritical: boolean
}

/**
 * Status icon mapping
 */
const statusIcons: Record<string, React.ReactNode> = {
  planned: <Circle className="h-3 w-3 text-muted-foreground" />,
  in_progress: <Clock className="h-3 w-3 text-blue-500 animate-pulse" />,
  complete: <CheckCircle className="h-3 w-3 text-emerald-500" />,
  blocked: <AlertCircle className="h-3 w-3 text-red-500" />,
}

/**
 * TaskNode Component
 * Custom ReactFlow node for tasks with status and dependency info
 */
const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskNodeData>) {
  const { task, dependencyCount, blocksCount, isSelected, isCritical } = data

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
      {/* Target handle */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-emerald-500 !border-background !w-3 !h-3"
      />

      {/* Task header with status */}
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

      {/* Source handle */}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-emerald-500 !border-background !w-3 !h-3"
      />
    </div>
  )
})

/**
 * IntegrationPointCard Component
 * Task: task-cbe-007
 *
 * Renders a single IntegrationPoint with PropertyRenderer for:
 * - changeType (via ChangeTypeBadge)
 * - filePath (via CodePathDisplay)
 * - description (via LongTextDisplay)
 */
function IntegrationPointCard({
  integrationPoint,
}: {
  integrationPoint: IntegrationPoint
}) {
  return (
    <div className="p-3 rounded-lg border bg-card border-emerald-500/20 hover:border-emerald-500/40 transition-colors">
      {/* Header with name and change type badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-medium text-sm text-foreground">{integrationPoint.name}</span>
        {integrationPoint.changeType && (
          <PropertyRenderer
            value={integrationPoint.changeType}
            property={changeTypeMeta}
          />
        )}
      </div>

      {/* File path via CodePathDisplay */}
      <div className="mb-2">
        <PropertyRenderer
          value={integrationPoint.filePath}
          property={filePathMeta}
          config={{ truncate: 50 }}
        />
      </div>

      {/* Description via LongTextDisplay */}
      <div className="text-sm">
        <PropertyRenderer
          value={integrationPoint.description}
          property={integrationPointDescriptionMeta}
          config={{ truncate: 100, size: "sm" }}
        />
      </div>
    </div>
  )
}

/**
 * IntegrationPointsSection Component
 * Task: task-cbe-007
 *
 * Displays a list of IntegrationPoints for a task using IntegrationPointCard
 */
function IntegrationPointsSection({
  integrationPoints,
}: {
  integrationPoints: IntegrationPoint[]
}) {
  if (!integrationPoints || integrationPoints.length === 0) return null

  return (
    <div className="mb-4">
      <div className="flex items-center gap-1.5 mb-2">
        <Link2 className="h-3 w-3 text-emerald-500" />
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          Integration Points
        </span>
        <span className="text-xs text-muted-foreground">
          ({integrationPoints.length})
        </span>
      </div>
      <div className="space-y-2">
        {integrationPoints.map((ip) => (
          <IntegrationPointCard key={ip.id} integrationPoint={ip} />
        ))}
      </div>
    </div>
  )
}

/**
 * TaskDetailsPanel Component
 * Shows details for selected task including associated IntegrationPoints
 */
function TaskDetailsPanel({
  task,
  integrationPoints,
  onClose,
}: {
  task: Task | null
  integrationPoints: IntegrationPoint[]
  onClose: () => void
}) {
  if (!task) return null

  // Filter integration points for this task (by matching task in integrationPoint)
  const taskIntegrationPoints = integrationPoints.filter(
    (ip: any) => ip.task === task.id
  )

  return (
    <div className="w-80 border-l border-emerald-500/20 bg-card p-4 overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-foreground">{task.name}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Status (via PropertyRenderer) */}
      <div className="mb-4">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Status</span>
        <div className="mt-1">
          <PropertyRenderer
            value={task.status}
            property={statusPropertyMeta}
          />
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="mb-4">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Description</span>
          <p className="text-sm mt-1 text-foreground">{task.description}</p>
        </div>
      )}

      {/* Acceptance Criteria (via PropertyRenderer) */}
      {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
        <div className="mb-4">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Acceptance Criteria
          </span>
          <div className="mt-1">
            <PropertyRenderer
              value={task.acceptanceCriteria}
              property={acceptanceCriteriaPropertyMeta}
              config={{
                size: "sm",
                layout: "compact",
              }}
            />
          </div>
        </div>
      )}

      {/* Integration Points (via PropertyRenderer) - Task: task-cbe-007 */}
      <IntegrationPointsSection integrationPoints={taskIntegrationPoints} />

      {/* Dependencies */}
      {task.dependencies && task.dependencies.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            Depends On
          </span>
          <div className="mt-1 flex flex-wrap gap-1">
            {task.dependencies.map((depId: string) => (
              <span
                key={depId}
                className="px-2 py-0.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded text-xs"
              >
                {depId}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Calculate dependency levels for horizontal layout
 */
function calculateDependencyLevels(tasks: Task[]): Map<string, number> {
  const levels = new Map<string, number>()
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  function getLevel(taskId: string, visited = new Set<string>()): number {
    if (levels.has(taskId)) return levels.get(taskId)!
    if (visited.has(taskId)) return 0 // Cycle detection

    const task = taskMap.get(taskId)
    if (!task || !task.dependencies || task.dependencies.length === 0) {
      levels.set(taskId, 0)
      return 0
    }

    visited.add(taskId)
    const maxDepLevel = Math.max(
      ...task.dependencies.map(depId => getLevel(depId, visited))
    )
    const level = maxDepLevel + 1
    levels.set(taskId, level)
    return level
  }

  tasks.forEach(task => getLevel(task.id))
  return levels
}

/**
 * Find the critical path (longest dependency chain)
 */
function findCriticalPath(tasks: Task[]): Set<string> {
  const levels = calculateDependencyLevels(tasks)
  const criticalPath = new Set<string>()

  // Find max level
  let maxLevel = 0
  let endTaskId = ""
  for (const [id, level] of levels) {
    if (level > maxLevel) {
      maxLevel = level
      endTaskId = id
    }
  }

  // Trace back through dependencies
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  function tracePath(taskId: string) {
    criticalPath.add(taskId)
    const task = taskMap.get(taskId)
    if (task?.dependencies && task.dependencies.length > 0) {
      // Find the dependency with the highest level
      let maxDepLevel = -1
      let nextTaskId = ""
      for (const depId of task.dependencies) {
        const depLevel = levels.get(depId) || 0
        if (depLevel > maxDepLevel) {
          maxDepLevel = depLevel
          nextTaskId = depId
        }
      }
      if (nextTaskId) tracePath(nextTaskId)
    }
  }

  if (endTaskId) tracePath(endTaskId)
  return criticalPath
}

/**
 * Transform tasks to ReactFlow nodes and edges
 */
function transformToGraph(
  tasks: Task[],
  selectedTaskId: string | null
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const levels = calculateDependencyLevels(tasks)
  const criticalPath = findCriticalPath(tasks)
  const blocksMap = new Map<string, number>()

  // Calculate how many tasks each task blocks
  tasks.forEach(task => {
    task.dependencies?.forEach(depId => {
      blocksMap.set(depId, (blocksMap.get(depId) || 0) + 1)
    })
  })

  // Group tasks by level
  const tasksByLevel = new Map<number, Task[]>()
  tasks.forEach(task => {
    const level = levels.get(task.id) || 0
    if (!tasksByLevel.has(level)) tasksByLevel.set(level, [])
    tasksByLevel.get(level)!.push(task)
  })

  // Create nodes with horizontal layout
  const nodes: Node<TaskNodeData>[] = []
  const nodeHeight = 100
  const nodeWidth = 250
  const levelGap = 280
  const verticalGap = 120

  for (const [level, levelTasks] of tasksByLevel) {
    const startY = -((levelTasks.length - 1) * verticalGap) / 2
    levelTasks.forEach((task, index) => {
      nodes.push({
        id: task.id,
        type: "taskNode",
        position: {
          x: level * levelGap,
          y: startY + index * verticalGap,
        },
        data: {
          task,
          dependencyCount: task.dependencies?.length || 0,
          blocksCount: blocksMap.get(task.id) || 0,
          isSelected: task.id === selectedTaskId,
          isCritical: criticalPath.has(task.id),
        },
      })
    })
  }

  // Create edges
  const edges: Edge[] = []
  tasks.forEach(task => {
    task.dependencies?.forEach(depId => {
      const isCriticalEdge = criticalPath.has(task.id) && criticalPath.has(depId)
      edges.push({
        id: `${depId}-${task.id}`,
        source: depId,
        target: task.id,
        style: {
          stroke: isCriticalEdge ? "#10b981" : "#10b98150", // emerald-500
          strokeWidth: isCriticalEdge ? 3 : 2,
        },
        animated: isCriticalEdge,
      })
    })
  })

  return { nodes, edges }
}

// Node types for ReactFlow
const nodeTypes = {
  taskNode: TaskNode,
}

/**
 * SpecView Component
 *
 * Displays the Spec phase with "Task Dependency Network" aesthetic:
 * 1. TaskDependencyGraph - ReactFlow with horizontal layered layout
 * 2. TaskNode - Shows status, dependency count, blocks count
 * 3. Critical path highlighted with emphasized edges
 * 4. Task details panel on selection
 */
export const SpecView = observer(function SpecView({
  feature,
}: SpecViewProps) {
  // Phase colors for spec (emerald)
  const phaseColors = usePhaseColor("spec")

  // Selected task state
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // Access platform-features domain for tasks
  const { platformFeatures } = useDomains()

  // Fetch tasks for this feature session
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []

  // Fetch integration points for this feature session (task-cbe-007)
  const integrationPoints: IntegrationPoint[] = platformFeatures?.integrationPointCollection?.findBySession?.(feature.id) ?? []

  // Transform tasks to graph
  const { nodes, edges } = useMemo(
    () => transformToGraph(tasks, selectedTaskId),
    [tasks, selectedTaskId]
  )

  // Find selected task
  const selectedTask = useMemo(
    () => tasks.find((t: Task) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  )

  // Handle node click
  const onNodeClick = useCallback((_: any, node: Node<TaskNodeData>) => {
    setSelectedTaskId(prev => (prev === node.id ? null : node.id))
  }, [])

  // Close details panel
  const handleCloseDetails = useCallback(() => {
    setSelectedTaskId(null)
  }, [])

  return (
    <div data-testid="spec-view" className="h-full flex flex-col overflow-hidden">
      {/* Dependency Network Header */}
      <div className={cn("flex items-center gap-2 pb-3 mb-3 border-b min-w-0", phaseColors.border)}>
        <GitBranch className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Task Dependency Network
        </h2>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          ({tasks.length} task{tasks.length !== 1 ? "s" : ""})
        </span>
      </div>

      {/* Content */}
      {tasks.length === 0 ? (
        <EmptyPhaseContent
          phaseName="spec"
          message="No implementation tasks defined"
          description="Run the Spec phase to generate implementation tasks from requirements."
        />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Graph Canvas */}
          <div
            className={cn(
              "flex-1 rounded-lg overflow-hidden border",
              "border-emerald-500/20 bg-emerald-500/5"
            )}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.5}
              maxZoom={1.5}
            >
              <Background color="#10b98110" gap={20} />
              <Controls />
            </ReactFlow>
          </div>

          {/* Task Details Panel */}
          <TaskDetailsPanel task={selectedTask} integrationPoints={integrationPoints} onClose={handleCloseDetails} />
        </div>
      )}
    </div>
  )
})
