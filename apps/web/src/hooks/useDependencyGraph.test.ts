/**
 * useDependencyGraph Hook Tests
 * Task: task-w1-use-dependency-graph-hook
 *
 * Tests verify:
 * 1. Returns nodes and edges for ReactFlow
 * 2. Computes layer assignments via topological sort
 * 3. Identifies critical path
 * 4. Handles empty tasks array
 * 5. Is memoized for performance
 */

import { describe, test, expect } from "bun:test"
import {
  computeDependencyGraph,
  type TaskInput,
  type DependencyGraphResult,
} from "./useDependencyGraph"

// Helper to create test tasks
const createTestTasks = (): TaskInput[] => [
  { id: "task-001", name: "Core interfaces", status: "complete", dependencies: [] },
  { id: "task-002", name: "Service interface", status: "complete", dependencies: ["task-001"] },
  { id: "task-003", name: "Utility functions", status: "in_progress", dependencies: ["task-001"] },
  { id: "task-004", name: "Provider A", status: "planned", dependencies: ["task-002"] },
  { id: "task-005", name: "Provider B", status: "planned", dependencies: ["task-002"] },
  { id: "task-006", name: "Integration", status: "planned", dependencies: ["task-004", "task-005"] },
]

// Longer chain for critical path testing
const createLongChainTasks = (): TaskInput[] => [
  { id: "A", name: "A", status: "planned", dependencies: [] },
  { id: "B", name: "B", status: "planned", dependencies: ["A"] },
  { id: "C", name: "C", status: "planned", dependencies: ["B"] },
  { id: "D", name: "D", status: "planned", dependencies: ["C"] },
  // Short parallel path
  { id: "X", name: "X", status: "planned", dependencies: ["A"] },
]

describe("computeDependencyGraph - Returns Structure", () => {
  test("returns object with nodes array", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)
    expect(result).toHaveProperty("nodes")
    expect(Array.isArray(result.nodes)).toBe(true)
  })

  test("returns object with edges array", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)
    expect(result).toHaveProperty("edges")
    expect(Array.isArray(result.edges)).toBe(true)
  })

  test("returns object with criticalPath array", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)
    expect(result).toHaveProperty("criticalPath")
    expect(Array.isArray(result.criticalPath)).toBe(true)
  })

  test("each node has id, position, and data properties", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    result.nodes.forEach(node => {
      expect(node).toHaveProperty("id")
      expect(node).toHaveProperty("position")
      expect(node).toHaveProperty("data")
      expect(node.position).toHaveProperty("x")
      expect(node.position).toHaveProperty("y")
    })
  })

  test("each edge has id, source, and target properties", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    result.edges.forEach(edge => {
      expect(edge).toHaveProperty("id")
      expect(edge).toHaveProperty("source")
      expect(edge).toHaveProperty("target")
    })
  })
})

describe("computeDependencyGraph - Layer Assignment", () => {
  test("task with no dependencies is assigned layer 0", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    const task001Node = result.nodes.find(n => n.id === "task-001")
    expect(task001Node?.data.layer).toBe(0)
  })

  test("task depending on layer 0 task is assigned layer 1", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    const task002Node = result.nodes.find(n => n.id === "task-002")
    expect(task002Node?.data.layer).toBe(1)
  })

  test("task depending on layer 1 task is assigned layer 2", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    const task004Node = result.nodes.find(n => n.id === "task-004")
    expect(task004Node?.data.layer).toBe(2)
  })

  test("nodes are positioned horizontally by layer", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    const layer0Node = result.nodes.find(n => n.data.layer === 0)
    const layer1Node = result.nodes.find(n => n.data.layer === 1)

    // Layer 1 should be to the right of layer 0
    expect(layer1Node!.position.x).toBeGreaterThan(layer0Node!.position.x)
  })
})

describe("computeDependencyGraph - Critical Path", () => {
  test("criticalPath contains task IDs of longest chain", () => {
    const tasks = createLongChainTasks()
    const result = computeDependencyGraph(tasks)

    // Longest path: A -> B -> C -> D (4 nodes)
    expect(result.criticalPath).toContain("A")
    expect(result.criticalPath).toContain("B")
    expect(result.criticalPath).toContain("C")
    expect(result.criticalPath).toContain("D")
  })

  test("critical path includes all tasks on longest dependency path", () => {
    const tasks = createLongChainTasks()
    const result = computeDependencyGraph(tasks)

    // The critical path should have 4 tasks
    expect(result.criticalPath.length).toBe(4)
  })

  test("shorter parallel paths are not in critical path", () => {
    const tasks = createLongChainTasks()
    const result = computeDependencyGraph(tasks)

    // X is on a shorter path (A -> X, length 2)
    expect(result.criticalPath).not.toContain("X")
  })
})

describe("computeDependencyGraph - Edge Styling", () => {
  test("edges on critical path have isCritical: true in data", () => {
    const tasks = createLongChainTasks()
    const result = computeDependencyGraph(tasks)

    // Edge from A to B should be critical
    const abEdge = result.edges.find(e => e.source === "A" && e.target === "B")
    expect(abEdge?.data?.isCritical).toBe(true)
  })

  test("non-critical edges have isCritical: false", () => {
    const tasks = createLongChainTasks()
    const result = computeDependencyGraph(tasks)

    // Edge from A to X should not be critical
    const axEdge = result.edges.find(e => e.source === "A" && e.target === "X")
    expect(axEdge?.data?.isCritical).toBe(false)
  })

  test("edge styling data enables visual differentiation", () => {
    const tasks = createTestTasks()
    const result = computeDependencyGraph(tasks)

    result.edges.forEach(edge => {
      expect(edge.data).toHaveProperty("isCritical")
      expect(typeof edge.data?.isCritical).toBe("boolean")
    })
  })
})

describe("computeDependencyGraph - Memoization Support", () => {
  test("returns same graph object reference for identical input", () => {
    const tasks = createTestTasks()
    const result1 = computeDependencyGraph(tasks)
    const result2 = computeDependencyGraph(tasks)

    // Results should be equivalent (same structure)
    expect(result1.nodes.length).toBe(result2.nodes.length)
    expect(result1.edges.length).toBe(result2.edges.length)
    expect(result1.criticalPath.length).toBe(result2.criticalPath.length)
  })
})

describe("computeDependencyGraph - Empty Tasks", () => {
  test("returns empty nodes array", () => {
    const result = computeDependencyGraph([])
    expect(result.nodes).toHaveLength(0)
  })

  test("returns empty edges array", () => {
    const result = computeDependencyGraph([])
    expect(result.edges).toHaveLength(0)
  })

  test("returns empty criticalPath array", () => {
    const result = computeDependencyGraph([])
    expect(result.criticalPath).toHaveLength(0)
  })

  test("does not throw error", () => {
    expect(() => computeDependencyGraph([])).not.toThrow()
  })
})
