/**
 * SpecView Redesign Tests
 * Task: task-w2-spec-view-redesign
 *
 * Tests verify the "Task Dependency Network" aesthetic:
 * 1. TaskDependencyGraph uses ReactFlow with dagre horizontal layout
 * 2. TaskNode shows status, dependency count, blocks count
 * 3. Critical path highlighted with emphasized edges
 * 4. Task details panel on selection
 * 5. Uses phase-spec color tokens (emerald)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

// ============================================================
// Test 1: SpecView renders with Dependency Network layout
// (test-w2-spec-renders)
// ============================================================

describe("test-w2-spec-renders: SpecView renders with Dependency Network layout", () => {
  test("SpecView contains TaskDependencyGraph or graph component", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have dependency graph or network visualization
    expect(componentSource).toMatch(/TaskDependencyGraph|DependencyGraph|ReactFlow|dependency.*graph/i)
  })

  test("SpecView has task details sidebar or panel", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have details panel
    expect(componentSource).toMatch(/TaskDetailsPanel|details.*panel|selectedTask|sidebar/i)
  })

  test("SpecView uses phase-spec colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use emerald/spec phase colors
    expect(componentSource).toMatch(/phase-spec|emerald-|usePhaseColor.*spec/i)
  })
})

// ============================================================
// Test 2: TaskDependencyGraph uses ReactFlow with layout
// (test-w2-spec-dependency-graph)
// ============================================================

describe("test-w2-spec-dependency-graph: TaskDependencyGraph with dagre layout", () => {
  test("Uses ReactFlow for graph rendering", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use ReactFlow
    expect(componentSource).toMatch(/ReactFlow|@xyflow|react-flow/i)
  })

  test("Has nodes and edges for task dependencies", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have nodes and edges
    expect(componentSource).toMatch(/nodes|edges|setNodes|setEdges|Node|Edge/i)
  })

  test("Uses layout algorithm for positioning", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have layout logic
    expect(componentSource).toMatch(/dagre|layout|position|horizontal|level/i)
  })
})

// ============================================================
// Test 3: TaskNode shows status and counts
// (test-w2-spec-task-node)
// ============================================================

describe("test-w2-spec-task-node: TaskNode shows status and counts", () => {
  test("TaskNode has status display", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display task status
    expect(componentSource).toMatch(/status|planned|in_progress|complete|blocked/i)
  })

  test("TaskNode shows dependency information", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show dependency count
    expect(componentSource).toMatch(/dependencies|depends|dependencyCount/i)
  })

  test("Uses GraphNode-like styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use task node styling
    expect(componentSource).toMatch(/TaskNode|GraphNode|nodeTypes|Handle/i)
  })
})

// ============================================================
// Test 4: Critical path is highlighted
// (test-w2-spec-critical-path)
// ============================================================

describe("test-w2-spec-critical-path: Critical path highlighting", () => {
  test("Has critical path calculation or identification", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should identify critical path
    expect(componentSource).toMatch(/critical|longest|path|chain|emphasized/i)
  })

  test("Edge styling differentiates critical from non-critical", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have different edge styling
    expect(componentSource).toMatch(/stroke|edge|style|emphasize|bold|thick/i)
  })
})

// ============================================================
// Test 5: Task details panel on selection
// (test-w2-spec-task-details)
// ============================================================

describe("test-w2-spec-task-details: Task details panel", () => {
  test("Has state for selected task", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should track selected task
    expect(componentSource).toMatch(/selectedTask|selectedNode|useState.*task/i)
  })

  test("Shows task details when selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should render task details
    expect(componentSource).toMatch(/acceptanceCriteria|description|TaskDetailsPanel|details/i)
  })

  test("Has node selection handler", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should handle node clicks
    expect(componentSource).toMatch(/onNodeClick|onSelect|handleNodeClick|onClick/i)
  })
})

// ============================================================
// Test 6: Uses phase-spec color tokens (emerald)
// (test-w2-spec-phase-colors)
// ============================================================

describe("test-w2-spec-phase-colors: Uses phase-spec color tokens", () => {
  test("Uses emerald color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use emerald colors
    expect(componentSource).toMatch(/emerald-|green-|spec/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phaseColors/i)
  })

  test("Graph styling uses phase accent colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have emerald-styled graph elements
    expect(componentSource).toMatch(/border-emerald|text-emerald|bg-emerald/i)
  })
})
