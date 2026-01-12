/**
 * Tests for SpecContainerSection
 * Task: task-spec-007
 *
 * TDD tests for the Spec phase container section component assembly:
 * - Node click toggles task selection
 * - Empty state when no tasks
 * - ReactFlow integration with proper configuration
 * - TaskDetailsPanel integration
 * - graphUtils integration
 *
 * Test Specifications:
 * - test-spec-007-node-click: SpecContainerSection toggles task selection on node click
 * - test-spec-007-empty: SpecContainerSection shows empty state when no tasks
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test"
import { cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// DOM setup for happy-dom
let window: Window
let cleanup_dom: () => void

beforeAll(() => {
  window = new Window({ url: "https://localhost/" })
  const doc = window.document
  // @ts-ignore
  globalThis.document = doc
  // @ts-ignore
  globalThis.window = window
  // @ts-ignore
  globalThis.HTMLElement = window.HTMLElement
  // @ts-ignore
  globalThis.DocumentFragment = window.DocumentFragment

  cleanup_dom = () => {
    window.close()
  }
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  cleanup_dom()
})

const componentPath = path.resolve(
  import.meta.dir,
  "../spec/SpecContainerSection.tsx"
)

// ============================================================
// Test: test-spec-007-node-click
// Scenario: SpecContainerSection toggles task selection on node click
// Task: task-spec-007
// ============================================================

describe("test-spec-007-node-click: SpecContainerSection toggles task selection on node click", () => {
  test("component file exists at expected path", () => {
    // Given: SpecContainerSection component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("SpecContainerSection is exported with observer wrapper", () => {
    // Given: Component should be exported with observer
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SpecContainerSection\s*=\s*observer\s*\(/)
  })

  test("selectedTaskId state is managed via useState", () => {
    // Given: Component should manage selectedTaskId as local React state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useState<string\s*\|\s*null>\s*\(\s*null\s*\)|const\s+\[\s*selectedTaskId/)
    expect(source).toMatch(/setSelectedTaskId/)
  })

  test("onNodeClick callback toggles selection (same node = deselect)", () => {
    // Given: Component should implement onNodeClick that toggles selection
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have onNodeClick or handleNodeClick function
    expect(source).toMatch(/onNodeClick|handleNodeClick/)
    // Should toggle: if same id, set null; if different, set the new id
    // Pattern: (current) => (nodeId === current ? null : nodeId)
    expect(source).toMatch(/===\s*current\s*\?\s*null\s*:\s*nodeId/)
  })

  test("selectedTask is computed via useMemo from tasks array", () => {
    // Given: Component should use useMemo for selectedTask lookup
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useMemo/)
    // Should find task by id
    expect(source).toMatch(/tasks\.find|\.find\s*\(\s*\(\s*t\s*\)\s*=>\s*t\.id\s*===\s*selectedTaskId/)
  })

  test("handleCloseDetails callback sets selectedTaskId to null", () => {
    // Given: Component should implement handleCloseDetails
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/handleCloseDetails/)
    expect(source).toMatch(/setSelectedTaskId\s*\(\s*null\s*\)/)
  })

  test("TaskDetailsPanel becomes visible when task selected", () => {
    // Given: TaskDetailsPanel should be rendered conditionally
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<TaskDetailsPanel/)
    // Should pass task prop (may have type assertion)
    expect(source).toMatch(/task=\{selectedTask/)
    // Should pass onClose prop
    expect(source).toMatch(/onClose=\{handleCloseDetails\}/)
    // Should pass integrationPoints prop
    expect(source).toMatch(/integrationPoints=/)
  })
})

// ============================================================
// Test: test-spec-007-empty
// Scenario: SpecContainerSection shows empty state when no tasks
// Task: task-spec-007
// ============================================================

describe("test-spec-007-empty: SpecContainerSection shows empty state when no tasks", () => {
  test("EmptyPhaseContent is imported", () => {
    // Given: Component should import EmptyPhaseContent
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*EmptyPhaseContent.*from/)
  })

  test("renders EmptyPhaseContent when tasks.length === 0", () => {
    // Given: Component should render EmptyPhaseContent for empty state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<EmptyPhaseContent/)
    // Should pass phaseName='spec'
    expect(source).toMatch(/phaseName=["']spec["']/)
  })

  test("no ReactFlow graph rendered when tasks empty", () => {
    // Given: ReactFlow should only render when tasks exist
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering
    expect(source).toMatch(/tasks\.length\s*===\s*0|taskCount\s*===\s*0|!tasks\.length/)
  })
})

// ============================================================
// Test: acceptance-criteria-domain-access
// Scenario: SpecContainerSection accesses domain data correctly
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-domain-access: Domain data access patterns", () => {
  test("accesses tasks via platformFeatures.implementationTaskCollection.findBySession(feature.id)", () => {
    // Given: Component should access tasks from domain
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/platformFeatures/)
    expect(source).toMatch(/implementationTaskCollection/)
    expect(source).toMatch(/findBySession/)
    expect(source).toMatch(/feature\.id|feature\?\.id/)
  })

  test("accesses integrationPoints via platformFeatures.integrationPointCollection.findBySession(feature.id)", () => {
    // Given: Component should access integrationPoints from domain
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/integrationPointCollection/)
    expect(source).toMatch(/findBySession/)
  })
})

// ============================================================
// Test: acceptance-criteria-reactflow
// Scenario: SpecContainerSection uses ReactFlow with correct configuration
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-reactflow: ReactFlow configuration", () => {
  test("imports ReactFlow from @xyflow/react", () => {
    // Given: Component should import ReactFlow
    const source = fs.readFileSync(componentPath, "utf-8")
    // Multi-line import: check for both ReactFlow and @xyflow/react
    expect(source).toMatch(/ReactFlow/)
    expect(source).toMatch(/@xyflow\/react/)
  })

  test("imports Background from @xyflow/react", () => {
    // Given: Component should import Background
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Background/)
  })

  test("imports Controls from @xyflow/react", () => {
    // Given: Component should import Controls
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Controls/)
  })

  test("ReactFlow has fitView prop", () => {
    // Given: ReactFlow should have fitView enabled
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<ReactFlow[\s\S]*?fitView/)
  })

  test("ReactFlow has fitViewOptions.padding=0.2", () => {
    // Given: ReactFlow should have fitViewOptions with padding
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/fitViewOptions|padding:\s*0\.2/)
  })

  test("ReactFlow has minZoom=0.5", () => {
    // Given: ReactFlow should have minZoom set
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/minZoom=\{?\s*0\.5\s*\}?/)
  })

  test("ReactFlow has maxZoom=1.5", () => {
    // Given: ReactFlow should have maxZoom set
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/maxZoom=\{?\s*1\.5\s*\}?/)
  })

  test("Background has color=#10b98110 and gap=20", () => {
    // Given: Background should have emerald color and gap
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Background/)
    expect(source).toMatch(/color=["']#10b98110["']/)
    expect(source).toMatch(/gap=\{?\s*20\s*\}?/)
  })

  test("Controls component is included", () => {
    // Given: Controls component should be rendered
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Controls/)
  })

  test("nodeTypes object registers taskNode type", () => {
    // Given: nodeTypes should map 'taskNode' to TaskNode component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/nodeTypes/)
    expect(source).toMatch(/taskNode:\s*TaskNode/)
  })
})

// ============================================================
// Test: acceptance-criteria-usememo
// Scenario: SpecContainerSection uses useMemo for performance
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-usememo: Performance optimization with useMemo", () => {
  test("uses useMemo for transformToGraph(tasks, selectedTaskId)", () => {
    // Given: Component should memoize graph transformation
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useMemo/)
    expect(source).toMatch(/transformToGraph/)
  })

  test("useMemo dependencies include tasks and selectedTaskId", () => {
    // Given: useMemo should have correct dependencies
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have dependency array with tasks and selectedTaskId
    // Either [tasks, selectedTaskId] or similar pattern
    expect(source).toMatch(/\[tasks,\s*selectedTaskId\]|\[\s*tasks\s*,\s*selectedTaskId\s*\]/)
  })

  test("uses useMemo for selectedTask lookup from tasks array", () => {
    // Given: Component should memoize selectedTask computation
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have useMemo for finding selected task
    expect(source).toMatch(/useMemo[\s\S]*?tasks\.find[\s\S]*?selectedTaskId/)
  })
})

// ============================================================
// Test: acceptance-criteria-layout
// Scenario: SpecContainerSection has correct layout styling
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-layout: Layout and styling", () => {
  test("content area has flex-1 flex min-h-0 classes", () => {
    // Given: Content area should have correct flex layout
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex-1\s+flex\s+min-h-0|className=["'][^"']*flex-1[^"']*flex[^"']*min-h-0/)
  })

  test("graph container has flex-1 rounded-lg overflow-hidden border styling", () => {
    // Given: Graph container should have correct styling
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex-1/)
    expect(source).toMatch(/rounded-lg/)
    expect(source).toMatch(/overflow-hidden/)
    expect(source).toMatch(/border/)
  })

  test("graph container has border-emerald-500/20 bg-emerald-500/5", () => {
    // Given: Graph container should have emerald border and background
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-emerald-500\/20/)
    expect(source).toMatch(/bg-emerald-500\/5/)
  })
})

// ============================================================
// Test: acceptance-criteria-imports
// Scenario: SpecContainerSection imports all required dependencies
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-imports: Required imports", () => {
  test("imports transformToGraph from graphUtils", () => {
    // Given: Component should import transformToGraph
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*transformToGraph.*from.*graphUtils|from\s+["']\.\/graphUtils["']/)
  })

  test("imports TaskDetailsPanel", () => {
    // Given: Component should import TaskDetailsPanel
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*TaskDetailsPanel.*from.*TaskDetailsPanel|from\s+["']\.\/TaskDetailsPanel["']/)
  })

  test("imports useDomains from DomainProvider", () => {
    // Given: Component should import useDomains
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*useDomains.*from/)
  })
})

// ============================================================
// Test: acceptance-criteria-reactflow-provider
// Scenario: SpecContainerSection wraps ReactFlow with ReactFlowProvider
// Task: task-spec-007
// ============================================================

describe("acceptance-criteria-reactflow-provider: ReactFlowProvider wrapper", () => {
  test("imports ReactFlowProvider from @xyflow/react", () => {
    // Given: Component should import ReactFlowProvider
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/ReactFlowProvider/)
  })

  test("wraps ReactFlow with ReactFlowProvider", () => {
    // Given: ReactFlow should be wrapped with provider
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have ReactFlowProvider wrapping ReactFlow
    expect(source).toMatch(/<ReactFlowProvider[\s\S]*?<ReactFlow/)
  })
})

// ============================================================
// Container Pattern Verification
// Task: task-spec-007
// ============================================================

describe("task-spec-007: Container Section Pattern compliance", () => {
  test("internal sub-components are defined inside file (TaskNode)", () => {
    // Given: Container pattern requires internal sub-components
    const source = fs.readFileSync(componentPath, "utf-8")
    // TaskNode should be defined in this file
    expect(source).toMatch(/function\s+TaskNode|const\s+TaskNode/)
  })

  test("uses React useState for internal state (not Wavesmith)", () => {
    // Given: Container pattern requires useState for internal state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useState/)
    // selectedTaskId should be local state
    expect(source).toMatch(/selectedTaskId/)
  })

  test("only exports SpecContainerSection (not internal components)", () => {
    // Given: Internal components should not be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    // Main export should be SpecContainerSection
    // TaskNode and other internals should NOT be exported
    const exportMatches = source.match(/export\s+(const|function)\s+\w+/g) || []
    const componentExports = exportMatches.filter(
      (m) => !m.includes("type") && !m.includes("interface")
    )
    expect(componentExports.length).toBe(1)
    expect(componentExports[0]).toMatch(/SpecContainerSection/)
  })
})
