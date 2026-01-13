/**
 * Graph Transformation Utilities
 * Task: task-spec-006
 *
 * Utility functions for transforming ImplementationTask arrays into
 * ReactFlow nodes and edges with proper layout positioning.
 *
 * Functions:
 * - calculateDependencyLevels: Recursive level calculation with cycle detection
 * - findCriticalPath: Finds the longest dependency chain
 * - transformToGraph: Converts tasks to ReactFlow nodes/edges
 *
 * @see test-spec-006-graph-transform for test specifications
 */

import type { Node, Edge } from "@xyflow/react"

// ============================================================
// Types
// ============================================================

/**
 * Task input type for graph transformation
 * Matches the structure from platform-features ImplementationTask
 */
export interface Task {
  id: string
  name: string
  status: "planned" | "in_progress" | "complete" | "blocked"
  dependencies: string[]
  description?: string
  acceptanceCriteria?: string[]
}

/**
 * Extended node data for ReactFlow TaskNode
 */
export interface TaskNodeData {
  task: Task
  dependencyCount: number
  blocksCount: number
  isSelected: boolean
  isCritical: boolean
}

// ============================================================
// Layout Constants
// ============================================================

/**
 * Layout constants for ReactFlow graph positioning
 * - levelGap: Horizontal spacing between dependency levels (x-axis)
 * - verticalGap: Vertical spacing between nodes in same level (y-axis)
 * - nodeWidth: Width of task nodes for layout calculations
 */
export const LAYOUT_CONSTANTS = {
  levelGap: 280,
  verticalGap: 120,
  nodeWidth: 250,
} as const

// ============================================================
// calculateDependencyLevels
// ============================================================

/**
 * Calculate dependency levels for horizontal graph layout
 *
 * Uses recursive memoization with cycle detection:
 * - Tasks with no dependencies get level 0
 * - Tasks with dependencies get max(dependency levels) + 1
 * - Cycles are detected via visited set and default to level 0
 *
 * @param tasks - Array of Task objects
 * @returns Map of task ID to dependency level
 *
 * @example
 * ```ts
 * const levels = calculateDependencyLevels(tasks)
 * // Map { "task-A" => 0, "task-B" => 1, "task-C" => 1, "task-D" => 2 }
 * ```
 */
export function calculateDependencyLevels(tasks: Task[]): Map<string, number> {
  const levels = new Map<string, number>()

  // Early return for empty array
  if (tasks.length === 0) {
    return levels
  }

  // Build task lookup map
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  /**
   * Recursive function to get level for a task
   * Uses visited set for cycle detection
   */
  function getLevel(taskId: string, visited = new Set<string>()): number {
    // Return cached level if already calculated
    if (levels.has(taskId)) {
      return levels.get(taskId)!
    }

    // Cycle detection: if we've seen this task in current path, return 0
    if (visited.has(taskId)) {
      return 0
    }

    const task = taskMap.get(taskId)

    // Task not found or has no dependencies -> level 0
    if (!task || !task.dependencies || task.dependencies.length === 0) {
      levels.set(taskId, 0)
      return 0
    }

    // Mark as visited in current path
    visited.add(taskId)

    // Calculate max level of all dependencies
    const maxDepLevel = Math.max(
      ...task.dependencies.map(depId => getLevel(depId, visited))
    )

    // This task's level is max dependency level + 1
    const level = maxDepLevel + 1
    levels.set(taskId, level)

    return level
  }

  // Calculate level for each task
  tasks.forEach(task => getLevel(task.id))

  return levels
}

// ============================================================
// findCriticalPath
// ============================================================

/**
 * Find the critical path (longest dependency chain)
 *
 * Algorithm:
 * 1. Calculate dependency levels
 * 2. Find the task at maximum level (end of critical path)
 * 3. Trace back through dependencies, always choosing the highest-level dependency
 *
 * @param tasks - Array of Task objects
 * @returns Set of task IDs on the critical path
 *
 * @example
 * ```ts
 * const criticalPath = findCriticalPath(tasks)
 * // Set { "task-A", "task-B", "task-D" }
 * ```
 */
export function findCriticalPath(tasks: Task[]): Set<string> {
  const criticalPath = new Set<string>()

  // Early return for empty array
  if (tasks.length === 0) {
    return criticalPath
  }

  // Calculate levels first
  const levels = calculateDependencyLevels(tasks)

  // Find task at maximum level (end of critical path)
  let maxLevel = -1
  let endTaskId = ""
  for (const [id, level] of levels) {
    if (level > maxLevel) {
      maxLevel = level
      endTaskId = id
    }
  }

  // If no tasks found, return empty set
  if (!endTaskId) {
    return criticalPath
  }

  // Build task lookup map
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  /**
   * Trace back through dependencies
   * Always choose the dependency with the highest level
   */
  function tracePath(taskId: string): void {
    criticalPath.add(taskId)

    const task = taskMap.get(taskId)
    if (!task?.dependencies || task.dependencies.length === 0) {
      return
    }

    // Find the dependency with the highest level
    let maxDepLevel = -1
    let nextTaskId = ""
    for (const depId of task.dependencies) {
      const depLevel = levels.get(depId) ?? 0
      if (depLevel > maxDepLevel) {
        maxDepLevel = depLevel
        nextTaskId = depId
      }
    }

    // Continue tracing if we found a dependency
    if (nextTaskId) {
      tracePath(nextTaskId)
    }
  }

  // Start tracing from the end task
  tracePath(endTaskId)

  return criticalPath
}

// ============================================================
// transformToGraph
// ============================================================

/**
 * Transform tasks to ReactFlow nodes and edges
 *
 * Creates a horizontally-layered graph:
 * - X position based on dependency level (level * levelGap)
 * - Y position centered within each level group
 * - Critical path edges styled with animation and emphasis
 * - Non-critical edges styled with reduced opacity
 *
 * @param tasks - Array of Task objects
 * @param selectedTaskId - Currently selected task ID (or null)
 * @returns Object with nodes and edges arrays for ReactFlow
 *
 * @example
 * ```tsx
 * const { nodes, edges } = transformToGraph(tasks, selectedTaskId)
 * return <ReactFlow nodes={nodes} edges={edges} />
 * ```
 */
export function transformToGraph(
  tasks: Task[],
  selectedTaskId: string | null
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  // Early return for empty array
  if (tasks.length === 0) {
    return { nodes: [], edges: [] }
  }

  // Calculate dependency levels and critical path
  const levels = calculateDependencyLevels(tasks)
  const criticalPath = findCriticalPath(tasks)

  // Calculate blocksMap: how many tasks depend on each task
  const blocksMap = new Map<string, number>()
  tasks.forEach(task => {
    task.dependencies?.forEach(depId => {
      blocksMap.set(depId, (blocksMap.get(depId) || 0) + 1)
    })
  })

  // Group tasks by level for y-positioning
  const tasksByLevel = new Map<number, Task[]>()
  tasks.forEach(task => {
    const level = levels.get(task.id) ?? 0
    if (!tasksByLevel.has(level)) {
      tasksByLevel.set(level, [])
    }
    tasksByLevel.get(level)!.push(task)
  })

  // Create nodes with horizontal layout
  const nodes: Node<TaskNodeData>[] = []
  const { levelGap, verticalGap } = LAYOUT_CONSTANTS

  for (const [level, levelTasks] of tasksByLevel) {
    // Center tasks vertically around y=0
    // startY = -((count - 1) * verticalGap) / 2
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
          dependencyCount: task.dependencies?.length ?? 0,
          blocksCount: blocksMap.get(task.id) ?? 0,
          isSelected: task.id === selectedTaskId,
          isCritical: criticalPath.has(task.id),
        },
      })
    })
  }

  // Create edges with critical path styling
  const edges: Edge[] = []
  tasks.forEach(task => {
    task.dependencies?.forEach(depId => {
      // Check if this edge is on the critical path
      // Both source and target must be on critical path
      const isCriticalEdge =
        criticalPath.has(task.id) && criticalPath.has(depId)

      edges.push({
        id: `${depId}-${task.id}`,
        source: depId,
        target: task.id,
        style: {
          stroke: isCriticalEdge ? "#10b981" : "#10b98150", // emerald-500 or faded
          strokeWidth: isCriticalEdge ? 3 : 2,
        },
        animated: isCriticalEdge,
      })
    })
  })

  return { nodes, edges }
}
