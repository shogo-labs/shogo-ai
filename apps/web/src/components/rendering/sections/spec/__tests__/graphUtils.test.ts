/**
 * Tests for Graph Transformation Utilities
 * Task: task-spec-006
 *
 * TDD tests for:
 * - calculateDependencyLevels: recursive level calculation with cycle detection
 * - findCriticalPath: finds longest dependency chain
 * - transformToGraph: converts tasks to ReactFlow nodes/edges
 *
 * Test Specification: test-spec-006-graph-transform
 */

import { describe, test, expect } from "bun:test"

// Import the utilities we'll implement
import {
  calculateDependencyLevels,
  findCriticalPath,
  transformToGraph,
  LAYOUT_CONSTANTS,
  type Task,
  type TaskNodeData,
} from "../graphUtils"

// ============================================================
// Test Data Fixtures
// ============================================================

/**
 * Creates test task data
 * Layout: A (no deps) -> B, C (depend on A) -> D (depends on B and C)
 */
function createTestTasks(): Task[] {
  return [
    {
      id: "task-A",
      name: "Task A - Foundation",
      status: "complete",
      dependencies: [],
    },
    {
      id: "task-B",
      name: "Task B - Feature 1",
      status: "in_progress",
      dependencies: ["task-A"],
    },
    {
      id: "task-C",
      name: "Task C - Feature 2",
      status: "planned",
      dependencies: ["task-A"],
    },
    {
      id: "task-D",
      name: "Task D - Integration",
      status: "planned",
      dependencies: ["task-B", "task-C"],
    },
  ]
}

/**
 * Creates a more complex task graph for critical path testing
 * Layout:
 *   A (level 0) -> B (level 1) -> D (level 2) -> F (level 3)
 *   A (level 0) -> C (level 1) -> E (level 2)
 *   E also depends on D
 * Critical path: A -> B -> D -> E (length 4)
 */
function createComplexTestTasks(): Task[] {
  return [
    {
      id: "task-A",
      name: "Task A",
      status: "complete",
      dependencies: [],
    },
    {
      id: "task-B",
      name: "Task B",
      status: "in_progress",
      dependencies: ["task-A"],
    },
    {
      id: "task-C",
      name: "Task C",
      status: "planned",
      dependencies: ["task-A"],
    },
    {
      id: "task-D",
      name: "Task D",
      status: "planned",
      dependencies: ["task-B"],
    },
    {
      id: "task-E",
      name: "Task E",
      status: "planned",
      dependencies: ["task-C", "task-D"],
    },
  ]
}

/**
 * Creates tasks with a potential cycle (for cycle detection testing)
 * Note: This represents invalid data that should be handled gracefully
 */
function createTasksWithCycle(): Task[] {
  return [
    {
      id: "task-A",
      name: "Task A",
      status: "planned",
      dependencies: ["task-C"], // Cycle: A -> C -> B -> A
    },
    {
      id: "task-B",
      name: "Task B",
      status: "planned",
      dependencies: ["task-A"],
    },
    {
      id: "task-C",
      name: "Task C",
      status: "planned",
      dependencies: ["task-B"],
    },
  ]
}

// ============================================================
// Test: calculateDependencyLevels
// ============================================================

describe("test-spec-006-graph-transform: calculateDependencyLevels", () => {
  test("tasks with no dependencies get level 0", () => {
    // Given: Array of tasks where Task A has no dependencies
    const tasks = createTestTasks()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: Task A should be at level 0
    expect(levels.get("task-A")).toBe(0)
  })

  test("tasks depending on level 0 tasks get level 1", () => {
    // Given: Tasks B and C depend only on A (level 0)
    const tasks = createTestTasks()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: B and C should be at level 1 (max dep level 0 + 1)
    expect(levels.get("task-B")).toBe(1)
    expect(levels.get("task-C")).toBe(1)
  })

  test("tasks get max(dependency levels) + 1", () => {
    // Given: Task D depends on B and C (both level 1)
    const tasks = createTestTasks()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: D should be at level 2 (max of 1,1) + 1 = 2
    expect(levels.get("task-D")).toBe(2)
  })

  test("returns Map with all task levels", () => {
    // Given: 4 tasks
    const tasks = createTestTasks()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: Map should have 4 entries
    expect(levels.size).toBe(4)
  })

  test("handles empty task array", () => {
    // Given: Empty array
    const tasks: Task[] = []

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: Empty map returned
    expect(levels.size).toBe(0)
  })

  test("handles cycle detection gracefully", () => {
    // Given: Tasks with cyclic dependencies
    const tasks = createTasksWithCycle()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: Should not throw, all tasks should have some level
    expect(levels.size).toBe(3)
    // Cyclic tasks should default to level 0 when cycle detected
    for (const [, level] of levels) {
      expect(typeof level).toBe("number")
      expect(level).toBeGreaterThanOrEqual(0)
    }
  })

  test("complex multi-level graph", () => {
    // Given: Complex task graph with 5 tasks
    const tasks = createComplexTestTasks()

    // When: calculateDependencyLevels is called
    const levels = calculateDependencyLevels(tasks)

    // Then: Levels should be correctly assigned
    expect(levels.get("task-A")).toBe(0) // No deps
    expect(levels.get("task-B")).toBe(1) // Depends on A
    expect(levels.get("task-C")).toBe(1) // Depends on A
    expect(levels.get("task-D")).toBe(2) // Depends on B
    expect(levels.get("task-E")).toBe(3) // Depends on C (level 1) and D (level 2), so max(1,2)+1=3
  })
})

// ============================================================
// Test: findCriticalPath
// ============================================================

describe("test-spec-006-graph-transform: findCriticalPath", () => {
  test("returns Set of task IDs on critical path", () => {
    // Given: Task graph
    const tasks = createTestTasks()

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Should return a Set
    expect(criticalPath instanceof Set).toBe(true)
  })

  test("critical path includes max-level task", () => {
    // Given: Task D is at max level (2)
    const tasks = createTestTasks()

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Should include task-D
    expect(criticalPath.has("task-D")).toBe(true)
  })

  test("critical path includes root task", () => {
    // Given: Task A is the only root (level 0)
    const tasks = createTestTasks()

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Should include task-A
    expect(criticalPath.has("task-A")).toBe(true)
  })

  test("traces back through highest-level dependencies", () => {
    // Given: Complex graph where D depends on B (via longer path)
    const tasks = createComplexTestTasks()

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Critical path should be A -> B -> D -> E (4 nodes)
    expect(criticalPath.has("task-A")).toBe(true)
    expect(criticalPath.has("task-B")).toBe(true)
    expect(criticalPath.has("task-D")).toBe(true)
    expect(criticalPath.has("task-E")).toBe(true)
    // C is not on critical path (parallel branch)
    expect(criticalPath.has("task-C")).toBe(false)
  })

  test("handles empty task array", () => {
    // Given: Empty array
    const tasks: Task[] = []

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Empty Set returned
    expect(criticalPath.size).toBe(0)
  })

  test("single task is its own critical path", () => {
    // Given: Single task
    const tasks: Task[] = [
      { id: "task-A", name: "Task A", status: "planned", dependencies: [] },
    ]

    // When: findCriticalPath is called
    const criticalPath = findCriticalPath(tasks)

    // Then: Should contain just that task
    expect(criticalPath.size).toBe(1)
    expect(criticalPath.has("task-A")).toBe(true)
  })
})

// ============================================================
// Test: transformToGraph
// ============================================================

describe("test-spec-006-graph-transform: transformToGraph returns correct structure", () => {
  test("returns nodes and edges arrays", () => {
    // Given: Task array
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const result = transformToGraph(tasks, null)

    // Then: Should have nodes and edges properties
    expect(Array.isArray(result.nodes)).toBe(true)
    expect(Array.isArray(result.edges)).toBe(true)
  })

  test("returns correct number of nodes", () => {
    // Given: 4 tasks
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Should have 4 nodes
    expect(nodes.length).toBe(4)
  })

  test("returns correct number of edges", () => {
    // Given: 4 tasks with 4 dependency relationships
    // A <- B, A <- C, B <- D, C <- D
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Should have 4 edges
    expect(edges.length).toBe(4)
  })

  test("handles empty task array", () => {
    // Given: Empty array
    const tasks: Task[] = []

    // When: transformToGraph is called
    const { nodes, edges } = transformToGraph(tasks, null)

    // Then: Empty arrays
    expect(nodes.length).toBe(0)
    expect(edges.length).toBe(0)
  })
})

describe("test-spec-006-graph-transform: transformToGraph node positioning", () => {
  test("nodes have correct x position based on level", () => {
    // Given: Tasks at different levels
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: x position = level * levelGap (280)
    const nodeA = nodes.find(n => n.id === "task-A")
    const nodeB = nodes.find(n => n.id === "task-B")
    const nodeD = nodes.find(n => n.id === "task-D")

    expect(nodeA?.position.x).toBe(0 * LAYOUT_CONSTANTS.levelGap) // Level 0
    expect(nodeB?.position.x).toBe(1 * LAYOUT_CONSTANTS.levelGap) // Level 1
    expect(nodeD?.position.x).toBe(2 * LAYOUT_CONSTANTS.levelGap) // Level 2
  })

  test("nodes in same level are vertically centered", () => {
    // Given: Tasks B and C both at level 1
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: B and C should be vertically distributed around center (0)
    const level1Nodes = nodes.filter(
      n => n.id === "task-B" || n.id === "task-C"
    )
    expect(level1Nodes.length).toBe(2)

    // With 2 nodes and verticalGap=120:
    // startY = -((2-1) * 120) / 2 = -60
    // node[0].y = -60 + 0 * 120 = -60
    // node[1].y = -60 + 1 * 120 = 60
    const yPositions = level1Nodes.map(n => n.position.y).sort((a, b) => a - b)
    expect(yPositions[0]).toBe(-60)
    expect(yPositions[1]).toBe(60)
  })

  test("single node in level is centered at y=0", () => {
    // Given: Task A alone at level 0
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: A should be at y=0
    const nodeA = nodes.find(n => n.id === "task-A")
    expect(nodeA?.position.y).toBe(0)
  })
})

describe("test-spec-006-graph-transform: transformToGraph node data", () => {
  test("node data includes task information", () => {
    // Given: Tasks
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Node data should include task
    const nodeA = nodes.find(n => n.id === "task-A")
    expect(nodeA?.data.task).toBeDefined()
    expect(nodeA?.data.task.id).toBe("task-A")
    expect(nodeA?.data.task.name).toBe("Task A - Foundation")
  })

  test("node data includes dependencyCount", () => {
    // Given: Task D has 2 dependencies
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Node D data should have dependencyCount=2
    const nodeD = nodes.find(n => n.id === "task-D")
    expect(nodeD?.data.dependencyCount).toBe(2)
  })

  test("node data includes blocksCount", () => {
    // Given: Task A is depended on by B and C (blocks 2 tasks)
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Node A data should have blocksCount=2
    const nodeA = nodes.find(n => n.id === "task-A")
    expect(nodeA?.data.blocksCount).toBe(2)
  })

  test("node data includes isSelected state", () => {
    // Given: Task B is selected
    const tasks = createTestTasks()

    // When: transformToGraph is called with selectedTaskId
    const { nodes } = transformToGraph(tasks, "task-B")

    // Then: Only node B should have isSelected=true
    const nodeB = nodes.find(n => n.id === "task-B")
    const nodeA = nodes.find(n => n.id === "task-A")

    expect(nodeB?.data.isSelected).toBe(true)
    expect(nodeA?.data.isSelected).toBe(false)
  })

  test("node data includes isCritical flag", () => {
    // Given: Tasks where A and D are on critical path
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Nodes on critical path should have isCritical=true
    const nodeA = nodes.find(n => n.id === "task-A")
    const nodeD = nodes.find(n => n.id === "task-D")

    expect(nodeA?.data.isCritical).toBe(true)
    expect(nodeD?.data.isCritical).toBe(true)
  })

  test("nodes have type='taskNode'", () => {
    // Given: Tasks
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: All nodes should have type='taskNode'
    nodes.forEach(node => {
      expect(node.type).toBe("taskNode")
    })
  })
})

describe("test-spec-006-graph-transform: transformToGraph edge styling", () => {
  test("critical path edges have strokeWidth=3", () => {
    // Given: Tasks with critical path edges
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Critical edges should have strokeWidth=3
    // Edge from A to B or D should be critical
    const criticalEdge = edges.find(e => {
      return (
        e.style?.strokeWidth === 3
      )
    })
    expect(criticalEdge).toBeDefined()
  })

  test("critical path edges have animated=true", () => {
    // Given: Tasks with critical path
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Critical edges should be animated
    const criticalEdge = edges.find(e => e.animated === true)
    expect(criticalEdge).toBeDefined()
  })

  test("critical path edges have stroke=#10b981", () => {
    // Given: Tasks with critical path
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Critical edges should have emerald color
    const criticalEdge = edges.find(e => e.style?.stroke === "#10b981")
    expect(criticalEdge).toBeDefined()
  })

  test("non-critical edges have strokeWidth=2", () => {
    // Given: Tasks where some edges are not critical
    const tasks = createComplexTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Non-critical edges should have strokeWidth=2
    const nonCriticalEdge = edges.find(e => e.style?.strokeWidth === 2)
    expect(nonCriticalEdge).toBeDefined()
  })

  test("non-critical edges have stroke=#10b98150", () => {
    // Given: Tasks where some edges are not critical
    const tasks = createComplexTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Non-critical edges should have faded emerald color
    const nonCriticalEdge = edges.find(e => e.style?.stroke === "#10b98150")
    expect(nonCriticalEdge).toBeDefined()
  })

  test("edge IDs follow pattern source-target", () => {
    // Given: Tasks
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Edge from A to B should have ID "task-A-task-B"
    const edgeAtoB = edges.find(
      e => e.source === "task-A" && e.target === "task-B"
    )
    expect(edgeAtoB?.id).toBe("task-A-task-B")
  })

  test("edges connect source to target correctly", () => {
    // Given: Task B depends on A
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { edges } = transformToGraph(tasks, null)

    // Then: Edge should go from A (source) to B (target)
    const edgeAtoB = edges.find(
      e => e.source === "task-A" && e.target === "task-B"
    )
    expect(edgeAtoB).toBeDefined()
  })
})

describe("test-spec-006-graph-transform: blocksMap calculation", () => {
  test("task blocking none has blocksCount=0", () => {
    // Given: Task D blocks no other tasks
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Node D should have blocksCount=0
    const nodeD = nodes.find(n => n.id === "task-D")
    expect(nodeD?.data.blocksCount).toBe(0)
  })

  test("task blocking one has blocksCount=1", () => {
    // Given: Tasks B and C each block D only
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Nodes B and C should have blocksCount=1
    const nodeB = nodes.find(n => n.id === "task-B")
    const nodeC = nodes.find(n => n.id === "task-C")

    expect(nodeB?.data.blocksCount).toBe(1)
    expect(nodeC?.data.blocksCount).toBe(1)
  })

  test("task blocking multiple has correct blocksCount", () => {
    // Given: Task A is depended on by B and C
    const tasks = createTestTasks()

    // When: transformToGraph is called
    const { nodes } = transformToGraph(tasks, null)

    // Then: Node A should have blocksCount=2
    const nodeA = nodes.find(n => n.id === "task-A")
    expect(nodeA?.data.blocksCount).toBe(2)
  })
})

describe("test-spec-006-graph-transform: LAYOUT_CONSTANTS", () => {
  test("levelGap is 280", () => {
    expect(LAYOUT_CONSTANTS.levelGap).toBe(280)
  })

  test("verticalGap is 120", () => {
    expect(LAYOUT_CONSTANTS.verticalGap).toBe(120)
  })

  test("nodeWidth is 250", () => {
    expect(LAYOUT_CONSTANTS.nodeWidth).toBe(250)
  })
})
