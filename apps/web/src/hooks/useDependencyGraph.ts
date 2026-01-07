/**
 * useDependencyGraph Hook
 * Task: task-w1-use-dependency-graph-hook
 *
 * Transforms ImplementationTask array into ReactFlow nodes and edges.
 * Computes layer assignments using topological sort and identifies the critical path.
 */

import { useMemo } from "react"
import type { Node, Edge } from "@xyflow/react"

/**
 * Minimal input type for tasks
 */
export interface TaskInput {
  id: string
  name: string
  status: "planned" | "in_progress" | "complete" | "blocked"
  dependencies: string[]
}

/**
 * Extended node data for ReactFlow
 */
export interface TaskNodeData {
  label: string
  status: string
  layer: number
  dependencyCount: number
  blocksCount: number
  task: TaskInput
}

/**
 * Extended edge data for ReactFlow
 */
export interface DependencyEdgeData {
  isCritical: boolean
}

/**
 * Result from the dependency graph computation
 */
export interface DependencyGraphResult {
  nodes: Node<TaskNodeData>[]
  edges: Edge<DependencyEdgeData>[]
  criticalPath: string[]
  layers: Map<number, string[]>
}

// Layout constants
const LAYER_WIDTH = 250
const NODE_HEIGHT = 80
const NODE_SPACING = 20

/**
 * Compute layer assignments using topological sort (Kahn's algorithm)
 */
function computeLayers(tasks: TaskInput[]): Map<string, number> {
  const layers = new Map<string, number>()
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  // Build adjacency list and compute in-degrees
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const task of tasks) {
    inDegree.set(task.id, task.dependencies.length)
    dependents.set(task.id, [])
  }

  // Build reverse adjacency (who depends on whom)
  for (const task of tasks) {
    for (const depId of task.dependencies) {
      const deps = dependents.get(depId) || []
      deps.push(task.id)
      dependents.set(depId, deps)
    }
  }

  // Start with tasks that have no dependencies (layer 0)
  let currentLayer = 0
  let currentQueue = tasks
    .filter(t => t.dependencies.length === 0)
    .map(t => t.id)

  while (currentQueue.length > 0) {
    const nextQueue: string[] = []

    for (const taskId of currentQueue) {
      layers.set(taskId, currentLayer)

      // Process all tasks that depend on this one
      const deps = dependents.get(taskId) || []
      for (const depId of deps) {
        const degree = (inDegree.get(depId) || 0) - 1
        inDegree.set(depId, degree)

        if (degree === 0) {
          nextQueue.push(depId)
        }
      }
    }

    currentQueue = nextQueue
    currentLayer++
  }

  return layers
}

/**
 * Find the critical path (longest dependency chain)
 */
function findCriticalPath(tasks: TaskInput[]): string[] {
  if (tasks.length === 0) return []

  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const memo = new Map<string, string[]>()

  // Recursive function to find longest path from a task
  function longestPathFrom(taskId: string): string[] {
    if (memo.has(taskId)) {
      return memo.get(taskId)!
    }

    const task = taskMap.get(taskId)
    if (!task) return []

    // Find dependent tasks (tasks that depend on this one)
    const dependents = tasks.filter(t => t.dependencies.includes(taskId))

    if (dependents.length === 0) {
      // This is a leaf node
      memo.set(taskId, [taskId])
      return [taskId]
    }

    // Find the longest path through dependents
    let longestSubPath: string[] = []
    for (const dependent of dependents) {
      const subPath = longestPathFrom(dependent.id)
      if (subPath.length > longestSubPath.length) {
        longestSubPath = subPath
      }
    }

    const result = [taskId, ...longestSubPath]
    memo.set(taskId, result)
    return result
  }

  // Find root tasks (no dependencies)
  const roots = tasks.filter(t => t.dependencies.length === 0)

  // Find the longest path starting from any root
  let criticalPath: string[] = []
  for (const root of roots) {
    const path = longestPathFrom(root.id)
    if (path.length > criticalPath.length) {
      criticalPath = path
    }
  }

  return criticalPath
}

/**
 * Count how many tasks depend on each task
 */
function computeBlocksCounts(tasks: TaskInput[]): Map<string, number> {
  const counts = new Map<string, number>()

  for (const task of tasks) {
    counts.set(task.id, 0)
  }

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      counts.set(depId, (counts.get(depId) || 0) + 1)
    }
  }

  return counts
}

/**
 * Pure function to compute dependency graph from tasks
 */
export function computeDependencyGraph(tasks: TaskInput[]): DependencyGraphResult {
  if (tasks.length === 0) {
    return {
      nodes: [],
      edges: [],
      criticalPath: [],
      layers: new Map(),
    }
  }

  // Compute layer assignments
  const layerAssignments = computeLayers(tasks)

  // Find critical path
  const criticalPath = findCriticalPath(tasks)
  const criticalPathSet = new Set(criticalPath)

  // Compute blocks counts
  const blocksCounts = computeBlocksCounts(tasks)

  // Group tasks by layer for y-positioning
  const layerGroups = new Map<number, string[]>()
  for (const [taskId, layer] of layerAssignments) {
    const group = layerGroups.get(layer) || []
    group.push(taskId)
    layerGroups.set(layer, group)
  }

  // Create nodes with position
  const nodes: Node<TaskNodeData>[] = tasks.map(task => {
    const layer = layerAssignments.get(task.id) || 0
    const layerTasks = layerGroups.get(layer) || []
    const indexInLayer = layerTasks.indexOf(task.id)

    return {
      id: task.id,
      type: "taskNode",
      position: {
        x: layer * LAYER_WIDTH,
        y: indexInLayer * (NODE_HEIGHT + NODE_SPACING),
      },
      data: {
        label: task.name,
        status: task.status,
        layer,
        dependencyCount: task.dependencies.length,
        blocksCount: blocksCounts.get(task.id) || 0,
        task,
      },
    }
  })

  // Create edges with critical path styling
  const edges: Edge<DependencyEdgeData>[] = []

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      // Edge goes from dependency TO dependent (depId -> task.id)
      const isCritical = criticalPathSet.has(depId) && criticalPathSet.has(task.id)

      edges.push({
        id: `${depId}-${task.id}`,
        source: depId,
        target: task.id,
        type: "smoothstep",
        data: {
          isCritical,
        },
        style: isCritical
          ? { stroke: "#ef4444", strokeWidth: 2 }
          : { stroke: "#71717a", strokeWidth: 1 },
        animated: isCritical,
      })
    }
  }

  return {
    nodes,
    edges,
    criticalPath,
    layers: layerGroups,
  }
}

/**
 * Hook that transforms tasks into ReactFlow graph data
 *
 * @param tasks - Array of ImplementationTask objects
 * @returns Graph data with nodes, edges, and critical path
 *
 * @example
 * ```tsx
 * function TaskDependencyGraph({ tasks }: { tasks: TaskInput[] }) {
 *   const { nodes, edges, criticalPath } = useDependencyGraph(tasks)
 *
 *   return (
 *     <ReactFlow nodes={nodes} edges={edges}>
 *       <Background />
 *     </ReactFlow>
 *   )
 * }
 * ```
 */
export function useDependencyGraph(tasks: TaskInput[]): DependencyGraphResult {
  return useMemo(() => computeDependencyGraph(tasks), [tasks])
}
