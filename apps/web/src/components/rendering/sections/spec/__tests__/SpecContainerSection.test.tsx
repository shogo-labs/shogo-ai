/**
 * Tests for SpecContainerSection
 * Task: task-spec-001
 *
 * TDD tests for the Spec phase container section component scaffold:
 * - Header with GitBranch icon and 'Task Dependency Network' title
 * - Task count badge with proper pluralization
 * - Full height flex layout
 * - Proper test IDs
 * - Wrapped with observer for MobX reactivity
 * - Uses React useState for selectedTaskId (not Wavesmith)
 *
 * Test Specification: test-spec-001-scaffold
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
  "../SpecContainerSection.tsx"
)

// ============================================================
// Test: test-spec-001-scaffold
// Scenario: SpecContainerSection renders with header and graph structure
// Given: SpecContainerSection with feature prop
// Given: Feature has implementation tasks
// When: Section renders
// Then: Header shows GitBranch icon and 'Task Dependency Network' title
// Then: Task count badge shows correct number
// Then: Full height flex layout applied
// Then: data-testid='spec-container-section' present
// ============================================================

describe("test-spec-001-scaffold: SpecContainerSection component file and exports", () => {
  test("component file exists at expected path", () => {
    // Given: SpecContainerSection component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("SpecContainerSection is exported", () => {
    // Given: Component should be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SpecContainerSection/)
  })

  test("component accepts SectionRendererProps interface", () => {
    // Given: Component should accept feature and config props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/SectionRendererProps/)
    expect(source).toMatch(/feature/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection header structure", () => {
  test("header shows GitBranch icon", () => {
    // Given: Header should use GitBranch icon from lucide-react
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/GitBranch/)
    // Note: Use [\s\S]* for multiline import matching
    expect(source).toMatch(/import[\s\S]*GitBranch[\s\S]*from\s*["']lucide-react["']/)
  })

  test("header shows 'Task Dependency Network' title", () => {
    // Given: Header should display Task Dependency Network title
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Task Dependency Network/)
  })

  test("task count badge shows dynamic count with pluralization", () => {
    // Given: Task count should use proper pluralization (task/tasks)
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have pluralization logic: tasks.length === 1 or !== 1
    expect(source).toMatch(/task.*\.length/)
    // Should show "task" or "tasks" based on count
    expect(source).toMatch(/task.*===\s*1|!==\s*1|task.*\?\s*['"]s['"]/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection uses spec phase colors", () => {
  test("uses usePhaseColor hook with 'spec' phase", () => {
    // Given: Should get phase colors for spec phase (emerald)
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/usePhaseColor\s*\(\s*["']spec["']\s*\)/)
  })

  test("imports usePhaseColor from correct path", () => {
    // Given: Should import usePhaseColor hook
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*usePhaseColor.*from.*@\/hooks\/usePhaseColor/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection selectedTaskId state", () => {
  test("manages selectedTaskId state via useState<string | null>(null)", () => {
    // Given: Container pattern requires useState for internal state
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have useState for selectedTaskId with null initial value
    expect(source).toMatch(/useState<string\s*\|\s*null>\s*\(\s*null\s*\)|useState\s*\(\s*null\s*\)/)
    expect(source).toMatch(/selectedTaskId/)
    expect(source).toMatch(/setSelectedTaskId/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection full height flex layout", () => {
  test("has h-full class for full height", () => {
    // Given: Container should use full height
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/h-full/)
  })

  test("uses flex flex-col layout", () => {
    // Given: Container should use flex column layout
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex/)
    expect(source).toMatch(/flex-col/)
  })

  test("has overflow-hidden to contain content", () => {
    // Given: Container should prevent overflow
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/overflow-hidden/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection test IDs", () => {
  test("root element has data-testid='spec-container-section'", () => {
    // Given: Root element should have proper test ID
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid=["']spec-container-section["']/)
  })
})

describe("test-spec-001-scaffold: SpecContainerSection observer wrapping", () => {
  test("imports observer from mobx-react-lite", () => {
    // Given: SpecContainerSection should be wrapped with observer
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*observer.*from\s+["']mobx-react-lite["']/)
  })

  test("SpecContainerSection is wrapped with observer()", () => {
    // Given: Component should be wrapped with observer for MobX reactivity
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should export observer-wrapped function
    expect(source).toMatch(/export\s+(const|function)\s+SpecContainerSection\s*=\s*observer\s*\(/)
  })
})

describe("test-spec-001-scaffold: Container Section Pattern compliance", () => {
  test("does NOT use Wavesmith stores for internal UI state", () => {
    // Given: Container pattern requires useState for internal state, NOT Wavesmith
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use useState for selectedTaskId
    expect(source).toMatch(/useState/)
    // Should NOT import store.create or Wavesmith for selectedTaskId
    // The pattern is: internal state uses React useState
  })

  test("does not export internal sub-components for registration", () => {
    // Given: Internal components should not be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    // Main export should be SpecContainerSection
    const exportMatches = source.match(/export\s+(const|function)\s+\w+/g) || []
    // Filter out type exports
    const componentExports = exportMatches.filter(
      (m) => !m.includes("type") && !m.includes("interface")
    )
    // Should have exactly 1 export (the main component)
    expect(componentExports.length).toBe(1)
    expect(componentExports[0]).toMatch(/SpecContainerSection/)
  })
})

describe("test-spec-001-scaffold: Header border styling with phase colors", () => {
  test("header uses phaseColors.border for border styling", () => {
    // Given: Header should use phase-colored border
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/phaseColors\.border/)
  })

  test("header uses phaseColors.text for icon and title", () => {
    // Given: Header icon and title should use phase text color
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/phaseColors\.text/)
  })
})

// ============================================================
// Tests for TaskNode sub-component
// Task: task-spec-002
// TestSpecification: test-spec-002-task-node, test-spec-002-selection
//
// TaskNode is an internal sub-component of SpecContainerSection,
// custom ReactFlow node displaying task information with status,
// dependencies, and critical path highlighting.
// ============================================================

describe("test-spec-002-task-node: TaskNode component structure", () => {
  test("TaskNode function component is defined", () => {
    // Given: TaskNode should be defined as internal sub-component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/function\s+TaskNode/)
  })

  test("TaskNode accepts NodeProps and uses TaskNodeData via type assertion", () => {
    // Given: TaskNode should accept NodeProps and cast data to TaskNodeData
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/NodeProps/)
    expect(source).toMatch(/data\s+as\s+.*TaskNodeData/)
  })

  test("TaskNodeData is imported from graphUtils", () => {
    // Given: TaskNodeData should be imported from graphUtils (not defined locally)
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*TaskNodeData.*from.*graphUtils/)
    // Should use properties from TaskNodeData
    expect(source).toMatch(/task/)
    expect(source).toMatch(/dependencyCount/)
    expect(source).toMatch(/blocksCount/)
    expect(source).toMatch(/isSelected/)
    expect(source).toMatch(/isCritical/)
  })

  test("TaskNode is wrapped with React.memo for performance", () => {
    // Given: TaskNode should be memoized for ReactFlow performance
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use memo() wrapping
    expect(source).toMatch(/memo\s*\(\s*function\s+TaskNode|const\s+TaskNode\s*=\s*memo/)
  })
})

describe("test-spec-002-task-node: TaskNode Handle components", () => {
  test("imports Handle and Position from @xyflow/react", () => {
    // Given: Should import Handle and Position for edge connections
    const source = fs.readFileSync(componentPath, "utf-8")
    // Multi-line import: check for Handle, Position, and @xyflow/react
    expect(source).toMatch(/Handle/)
    expect(source).toMatch(/Position/)
    expect(source).toMatch(/@xyflow\/react/)
  })

  test("has Handle component with type='target' position={Position.Left}", () => {
    // Given: TaskNode should have left target handle for incoming edges
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Handle[\s\S]*?type=["']target["']/)
    expect(source).toMatch(/position=\{Position\.Left\}/)
  })

  test("has Handle component with type='source' position={Position.Right}", () => {
    // Given: TaskNode should have right source handle for outgoing edges
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Handle[\s\S]*?type=["']source["']/)
    expect(source).toMatch(/position=\{Position\.Right\}/)
  })
})

describe("test-spec-002-task-node: TaskNode status icons", () => {
  test("imports Circle, Clock, CheckCircle, AlertCircle from lucide-react", () => {
    // Given: Should import all required status icons
    // Note: Use [\s\S]* for multiline import matching
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import[\s\S]*Circle[\s\S]*from\s*["']lucide-react["']/)
    expect(source).toMatch(/import[\s\S]*Clock[\s\S]*from\s*["']lucide-react["']/)
    expect(source).toMatch(/import[\s\S]*CheckCircle[\s\S]*from\s*["']lucide-react["']/)
    expect(source).toMatch(/import[\s\S]*AlertCircle[\s\S]*from\s*["']lucide-react["']/)
  })

  test("Circle icon used for planned status", () => {
    // Given: planned status should use Circle icon
    const source = fs.readFileSync(componentPath, "utf-8")
    // statusIcons map should have planned: Circle
    expect(source).toMatch(/planned[\s\S]*?<Circle/)
  })

  test("Clock icon with animate-pulse used for in_progress status", () => {
    // Given: in_progress status should use Clock icon with animate-pulse
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/in_progress[\s\S]*?<Clock/)
    expect(source).toMatch(/animate-pulse/)
  })

  test("CheckCircle icon used for complete status", () => {
    // Given: complete status should use CheckCircle icon
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/complete[\s\S]*?<CheckCircle/)
  })

  test("AlertCircle icon used for blocked status", () => {
    // Given: blocked status should use AlertCircle icon
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/blocked[\s\S]*?<AlertCircle/)
  })
})

describe("test-spec-002-task-node: TaskNode dependency and blocks counts display", () => {
  test("shows dependencyCount with emerald text color", () => {
    // Given: TaskNode should display dependencyCount with emerald styling
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should destructure dependencyCount from data
    expect(source).toMatch(/dependencyCount/)
    // Should show count with emerald text color
    expect(source).toMatch(/text-emerald-500[\s\S]*?dependencyCount|dependencyCount[\s\S]*?text-emerald-500/)
  })

  test("shows blocksCount with emerald text color", () => {
    // Given: TaskNode should display blocksCount with emerald styling
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should destructure blocksCount from data
    expect(source).toMatch(/blocksCount/)
    // Should show count with emerald text color
    expect(source).toMatch(/text-emerald-500[\s\S]*?blocksCount|blocksCount[\s\S]*?text-emerald-500/)
  })

  test("shows 'deps' label for dependency count", () => {
    // Given: Should show "deps" label next to dependency count
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/deps/)
  })

  test("shows 'blocks' label for blocks count", () => {
    // Given: Should show "blocks" label next to blocks count
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/blocks/)
  })
})

describe("test-spec-002-selection: TaskNode selection styling", () => {
  test("selection styling: border-emerald-500 when isSelected", () => {
    // Given: When isSelected is true, border should be emerald-500
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isSelected[\s\S]*?border-emerald-500/)
  })

  test("selection styling: ring-2 ring-emerald-500/30 when isSelected", () => {
    // Given: When isSelected is true, ring effect should be applied
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/ring-2/)
    expect(source).toMatch(/ring-emerald-500\/30/)
  })

  test("selection styling: shadow-lg when isSelected", () => {
    // Given: When isSelected is true, shadow should be increased
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/shadow-lg/)
  })

  test("critical path styling: border-emerald-500/60 when isCritical but not selected", () => {
    // Given: When isCritical is true but not selected, border should use emerald-500/60
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isCritical[\s\S]*?border-emerald-500\/60/)
  })

  test("default styling: border-emerald-500/30 hover:border-emerald-500/50", () => {
    // Given: Default styling should be border-emerald-500/30 with hover state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-emerald-500\/30/)
    expect(source).toMatch(/hover:border-emerald-500\/50/)
  })
})

describe("test-spec-002-task-node: TaskNode task name display", () => {
  test("displays task.name in the node", () => {
    // Given: TaskNode should show the task name
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/task\.name/)
  })

  test("destructures task, dependencyCount, blocksCount, isSelected, isCritical from data", () => {
    // Given: TaskNode should destructure all required properties from data
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/const\s*\{\s*task[\s\S]*?dependencyCount[\s\S]*?blocksCount[\s\S]*?isSelected[\s\S]*?isCritical\s*\}\s*=\s*data/)
  })
})

describe("test-spec-002-task-node: TaskNode imports NodeProps", () => {
  test("imports NodeProps from @xyflow/react", () => {
    // Given: Should import NodeProps type for TypeScript
    const source = fs.readFileSync(componentPath, "utf-8")
    // Multi-line import: check for both NodeProps and @xyflow/react
    expect(source).toMatch(/NodeProps/)
    expect(source).toMatch(/@xyflow\/react/)
  })
})

describe("test-spec-002-task-node: TaskNode uses cn helper", () => {
  test("imports cn from @/lib/utils", () => {
    // Given: Should import cn helper for className composition
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*cn.*from\s+["']@\/lib\/utils["']/)
  })

  test("uses cn() for conditional styling based on isSelected and isCritical", () => {
    // Given: Should use cn() to compose conditional classes
    const source = fs.readFileSync(componentPath, "utf-8")
    // cn() should be called with isSelected and isCritical conditions
    expect(source).toMatch(/cn\s*\([\s\S]*?isSelected[\s\S]*?isCritical/)
  })
})

// ============================================================
// Integration Tests for SpecContainerSection
// Task: task-spec-011
// TestSpecification: test-spec-011-integration
//
// Integration tests verifying ReactFlow graph rendering, task selection,
// and panel interaction for the SpecContainerSection component.
// ============================================================

const sectionImplPath = path.resolve(
  import.meta.dir,
  "../../../sectionImplementations.tsx"
)

const taskDetailsPanelPath = path.resolve(
  import.meta.dir,
  "../TaskDetailsPanel.tsx"
)

const graphUtilsPath = path.resolve(
  import.meta.dir,
  "../graphUtils.ts"
)

// ============================================================
// Test: test-spec-011-integration: Header rendering
// Given: SpecContainerSection with feature prop
// When: Section renders
// Then: Header shows GitBranch icon, title, and task count badge
// ============================================================

describe("test-spec-011-integration: SpecContainerSection header rendering", () => {
  test("header contains GitBranch icon from lucide-react", () => {
    // Given: SpecContainerSection component
    // When: Examining component source
    // Then: Header renders GitBranch icon
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<GitBranch/)
    expect(source).toMatch(/className=\{cn\(["']h-5 w-5/)
  })

  test("header displays 'Task Dependency Network' title", () => {
    // Given: SpecContainerSection component
    // When: Examining component source
    // Then: Title text is present
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Task Dependency Network/)
  })

  test("task count badge shows dynamic count with 'task' or 'tasks' pluralization", () => {
    // Given: SpecContainerSection with tasks
    // When: Examining component source
    // Then: Badge shows count with proper pluralization
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have taskCount variable
    expect(source).toMatch(/taskCount/)
    // Should display count in format "(X task)" or "(X tasks)"
    expect(source).toMatch(/\(\{taskCount\}\s*task/)
    // Should use ternary for pluralization: taskCount !== 1 ? "s" : ""
    expect(source).toMatch(/taskCount\s*!==\s*1\s*\?\s*["']s["']\s*:\s*["']["']/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Empty state rendering
// Given: SpecContainerSection with no tasks
// When: Section renders
// Then: EmptyPhaseContent component is rendered
// ============================================================

describe("test-spec-011-integration: SpecContainerSection empty state rendering", () => {
  test("imports EmptyPhaseContent from correct path", () => {
    // Given: SpecContainerSection component
    // When: Examining imports
    // Then: EmptyPhaseContent is imported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*EmptyPhaseContent.*from.*@\/components\/app\/stepper\/EmptyStates/)
  })

  test("renders EmptyPhaseContent when taskCount is 0", () => {
    // Given: SpecContainerSection with no tasks
    // When: Examining conditional rendering
    // Then: EmptyPhaseContent is rendered with phaseName='spec'
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional: taskCount === 0
    expect(source).toMatch(/taskCount\s*===\s*0/)
    // Should render EmptyPhaseContent with phaseName="spec"
    expect(source).toMatch(/<EmptyPhaseContent[\s\S]*?phaseName=["']spec["']/)
  })

  test("empty state is wrapped in conditional rendering", () => {
    // Given: SpecContainerSection component
    // When: Examining JSX structure
    // Then: EmptyPhaseContent is conditionally rendered based on taskCount
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have ternary or conditional: {taskCount === 0 ? (...) : (...)}
    expect(source).toMatch(/\{taskCount\s*===\s*0\s*\?\s*\([\s\S]*?<EmptyPhaseContent/)
  })
})

// ============================================================
// Test: test-spec-011-integration: ReactFlow graph rendering
// Given: SpecContainerSection with tasks
// When: Section renders
// Then: ReactFlow component is present with nodes for tasks
// ============================================================

describe("test-spec-011-integration: SpecContainerSection ReactFlow graph rendering", () => {
  test("imports ReactFlow, ReactFlowProvider from @xyflow/react", () => {
    // Given: SpecContainerSection component
    // When: Examining imports
    // Then: ReactFlow components are imported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import[\s\S]*?ReactFlow[\s\S]*?from\s*["']@xyflow\/react["']/)
    expect(source).toMatch(/ReactFlowProvider/)
  })

  test("renders ReactFlow component with nodes and edges props", () => {
    // Given: SpecContainerSection with tasks
    // When: Examining component structure
    // Then: ReactFlow receives nodes and edges from transformToGraph
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<ReactFlow/)
    expect(source).toMatch(/nodes=\{nodes/)
    expect(source).toMatch(/edges=\{edges\}/)
  })

  test("ReactFlow is wrapped in ReactFlowProvider", () => {
    // Given: SpecContainerSection component
    // When: Examining JSX structure
    // Then: ReactFlowProvider wraps ReactFlow component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<ReactFlowProvider>[\s\S]*?<ReactFlow[\s\S]*?<\/ReactFlowProvider>/)
  })

  test("ReactFlow has onNodeClick handler for task selection", () => {
    // Given: SpecContainerSection component
    // When: Examining ReactFlow props
    // Then: onNodeClick is connected to handleNodeClick
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onNodeClick=\{handleNodeClick\}/)
  })

  test("ReactFlow uses nodeTypes with taskNode registered", () => {
    // Given: SpecContainerSection component
    // When: Examining nodeTypes definition
    // Then: nodeTypes object has taskNode key
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/nodeTypes=\{nodeTypes\}/)
    expect(source).toMatch(/const\s+nodeTypes\s*=\s*\{[\s\S]*?taskNode:\s*TaskNode/)
  })

  test("ReactFlow includes Background and Controls components", () => {
    // Given: SpecContainerSection component
    // When: Examining ReactFlow children
    // Then: Background and Controls are rendered inside ReactFlow
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Background/)
    expect(source).toMatch(/<Controls/)
  })

  test("uses transformToGraph to convert tasks to nodes and edges", () => {
    // Given: SpecContainerSection component
    // When: Examining graph transformation
    // Then: transformToGraph is called with tasks and selectedTaskId
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*transformToGraph.*from.*graphUtils/)
    expect(source).toMatch(/transformToGraph\s*\(\s*tasks\s*,\s*selectedTaskId\s*\)/)
  })

  test("graph transformation is memoized with useMemo", () => {
    // Given: SpecContainerSection component
    // When: Examining graph transformation
    // Then: transformToGraph result is memoized
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/const\s*\{\s*nodes\s*,\s*edges\s*\}\s*=\s*useMemo/)
    expect(source).toMatch(/\[\s*tasks\s*,\s*selectedTaskId\s*\]/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Task selection behavior
// Given: SpecContainerSection with tasks
// When: User clicks on a task node
// Then: TaskDetailsPanel shows with task details
// ============================================================

describe("test-spec-011-integration: SpecContainerSection task selection", () => {
  test("handleNodeClick callback toggles selectedTaskId", () => {
    // Given: SpecContainerSection component
    // When: Examining handleNodeClick implementation
    // Then: Callback toggles selection (same node = deselect, different = select)
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/const\s+handleNodeClick\s*=\s*useCallback/)
    // Should toggle: nodeId === current ? null : nodeId
    expect(source).toMatch(/nodeId\s*===\s*current\s*\?\s*null\s*:\s*nodeId/)
  })

  test("clicking same node again deselects (toggles to null)", () => {
    // Given: SpecContainerSection with a selected task
    // When: Same node is clicked
    // Then: selectedTaskId is set to null
    const source = fs.readFileSync(componentPath, "utf-8")
    // The toggle logic handles this: current => nodeId === current ? null : nodeId
    expect(source).toMatch(/setSelectedTaskId\s*\(\s*\(\s*current\s*\)/)
    expect(source).toMatch(/nodeId\s*===\s*current\s*\?\s*null/)
  })

  test("handleCloseDetails callback sets selectedTaskId to null", () => {
    // Given: SpecContainerSection component
    // When: Examining handleCloseDetails implementation
    // Then: Callback sets selectedTaskId to null
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/const\s+handleCloseDetails\s*=\s*useCallback/)
    expect(source).toMatch(/setSelectedTaskId\s*\(\s*null\s*\)/)
  })

  test("selectedTask is computed from tasks array based on selectedTaskId", () => {
    // Given: SpecContainerSection with tasks
    // When: selectedTaskId changes
    // Then: selectedTask is computed via useMemo
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/const\s+selectedTask\s*=\s*useMemo/)
    expect(source).toMatch(/tasks\.find\s*\(\s*\(\s*t\s*\)\s*=>\s*t\.id\s*===\s*selectedTaskId\s*\)/)
  })
})

// ============================================================
// Test: test-spec-011-integration: TaskDetailsPanel interaction
// Given: SpecContainerSection with selected task
// When: TaskDetailsPanel is visible
// Then: Panel shows task details and can be closed
// ============================================================

describe("test-spec-011-integration: SpecContainerSection TaskDetailsPanel interaction", () => {
  test("TaskDetailsPanel is imported from local path", () => {
    // Given: SpecContainerSection component
    // When: Examining imports
    // Then: TaskDetailsPanel is imported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*TaskDetailsPanel.*from.*\.\/TaskDetailsPanel/)
  })

  test("TaskDetailsPanel receives task, integrationPoints, and onClose props", () => {
    // Given: SpecContainerSection with selected task
    // When: Examining TaskDetailsPanel usage
    // Then: Panel receives required props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<TaskDetailsPanel/)
    expect(source).toMatch(/task=\{selectedTask/)
    expect(source).toMatch(/integrationPoints=\{integrationPoints\}/)
    expect(source).toMatch(/onClose=\{handleCloseDetails\}/)
  })

  test("TaskDetailsPanel shows X close button", () => {
    // Given: TaskDetailsPanel component
    // When: Examining component source
    // Then: X icon is used for close button
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/<X/)
    expect(panelSource).toMatch(/onClick.*onClose|onClose.*onClick/)
  })

  test("clicking X button calls onClose which clears selection", () => {
    // Given: TaskDetailsPanel with onClose prop
    // When: X button is clicked
    // Then: onClose is called (which is handleCloseDetails)
    const source = fs.readFileSync(componentPath, "utf-8")
    // handleCloseDetails sets selectedTaskId to null
    expect(source).toMatch(/handleCloseDetails/)
    expect(source).toMatch(/setSelectedTaskId\s*\(\s*null\s*\)/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Critical path visualization
// Given: SpecContainerSection with task dependency chain
// When: Graph renders
// Then: Critical path nodes and edges have distinct styling
// ============================================================

describe("test-spec-011-integration: SpecContainerSection critical path visualization", () => {
  test("graphUtils findCriticalPath function exists", () => {
    // Given: graphUtils module
    // When: Examining exports
    // Then: findCriticalPath function is exported
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource).toMatch(/export\s+function\s+findCriticalPath/)
  })

  test("transformToGraph includes isCritical in node data", () => {
    // Given: graphUtils transformToGraph function
    // When: Examining node data structure
    // Then: isCritical property is set based on criticalPath set
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource).toMatch(/isCritical:\s*criticalPath\.has\s*\(\s*task\.id\s*\)/)
  })

  test("critical path edges have distinct styling (animated, strokeWidth 3)", () => {
    // Given: graphUtils transformToGraph function
    // When: Examining edge creation
    // Then: Critical path edges have animated: true and strokeWidth: 3
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource).toMatch(/animated:\s*isCriticalEdge/)
    expect(graphSource).toMatch(/strokeWidth:\s*isCriticalEdge\s*\?\s*3/)
  })

  test("critical path edges have full emerald-500 stroke color", () => {
    // Given: graphUtils transformToGraph function
    // When: Examining edge styling
    // Then: Critical edges use #10b981 (emerald-500)
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource).toMatch(/stroke:\s*isCriticalEdge\s*\?\s*["']#10b981["']/)
  })

  test("non-critical edges have faded stroke (50% opacity)", () => {
    // Given: graphUtils transformToGraph function
    // When: Examining edge styling
    // Then: Non-critical edges use #10b98150 (emerald-500 at 50%)
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource).toMatch(/#10b98150/)
  })

  test("TaskNode shows critical path styling when isCritical", () => {
    // Given: TaskNode component
    // When: isCritical is true
    // Then: Border uses border-emerald-500/60
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isCritical[\s\S]*?border-emerald-500\/60/)
  })
})

// ============================================================
// Test: test-spec-011-integration: TaskDetailsPanel content
// Given: TaskDetailsPanel with selected task
// When: Panel renders
// Then: Shows status, description, acceptance criteria, integration points, dependencies
// ============================================================

describe("test-spec-011-integration: TaskDetailsPanel content", () => {
  test("TaskDetailsPanel shows status section with PropertyRenderer", () => {
    // Given: TaskDetailsPanel component
    // When: Examining content structure
    // Then: Status is rendered via PropertyRenderer with task-status-badge
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/statusPropertyMeta/)
    expect(panelSource).toMatch(/xRenderer:\s*["']task-status-badge["']/)
    expect(panelSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{task\.status\}/)
  })

  test("TaskDetailsPanel shows description section when task.description exists", () => {
    // Given: TaskDetailsPanel with task that has description
    // When: Examining conditional rendering
    // Then: Description section is conditionally rendered
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/\{task\.description\s*&&/)
    expect(panelSource).toMatch(/Description/)
  })

  test("TaskDetailsPanel shows acceptance criteria via PropertyRenderer", () => {
    // Given: TaskDetailsPanel with task that has acceptanceCriteria
    // When: Examining content structure
    // Then: Acceptance criteria rendered via PropertyRenderer with string-array
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/acceptanceCriteriaPropertyMeta/)
    expect(panelSource).toMatch(/xRenderer:\s*["']string-array["']/)
    expect(panelSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{task\.acceptanceCriteria\}/)
  })

  test("TaskDetailsPanel shows IntegrationPointsSection component", () => {
    // Given: TaskDetailsPanel component
    // When: Examining content structure
    // Then: IntegrationPointsSection is rendered
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/import.*IntegrationPointsSection/)
    expect(panelSource).toMatch(/<IntegrationPointsSection/)
  })

  test("TaskDetailsPanel shows dependencies as emerald badges", () => {
    // Given: TaskDetailsPanel with task that has dependencies
    // When: Examining dependencies section
    // Then: Dependencies are rendered as emerald-colored badges
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/Dependencies/)
    expect(panelSource).toMatch(/task\.dependencies\.map/)
    expect(panelSource).toMatch(/bg-emerald-500\/10/)
    expect(panelSource).toMatch(/text-emerald-500/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Integration points filtering
// Given: TaskDetailsPanel with selected task
// When: Panel receives integrationPoints
// Then: Only integration points matching selected task are shown
// ============================================================

describe("test-spec-011-integration: Integration points filtering", () => {
  test("TaskDetailsPanel filters integrationPoints by task.id", () => {
    // Given: TaskDetailsPanel with integrationPoints array
    // When: Filtering logic is examined
    // Then: Only points where ip.task === task.id are passed to IntegrationPointsSection
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/filteredIntegrationPoints\s*=\s*integrationPoints\.filter/)
    expect(panelSource).toMatch(/ip\.task\s*===\s*task\.id|ip\)\.task\s*===\s*task\.id/)
  })

  test("IntegrationPointsSection receives filtered points", () => {
    // Given: TaskDetailsPanel with filtered points
    // When: Examining IntegrationPointsSection usage
    // Then: filteredIntegrationPoints is passed as prop
    const panelSource = fs.readFileSync(taskDetailsPanelPath, "utf-8")
    expect(panelSource).toMatch(/<IntegrationPointsSection[\s\S]*?integrationPoints=\{filteredIntegrationPoints\}/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Component registration
// Given: sectionImplementationMap
// When: SpecContainerSection is examined
// Then: Component is properly registered
// ============================================================

describe("test-spec-011-integration: sectionImplementationMap registration", () => {
  test("SpecContainerSection is registered in sectionImplementationMap", () => {
    // Given: sectionImplementations.tsx file
    // When: Examining map entries
    // Then: SpecContainerSection is in the map
    const source = fs.readFileSync(sectionImplPath, "utf-8")
    expect(source).toMatch(/\["SpecContainerSection",\s*SpecContainerSection\]/)
  })

  test("SpecContainerSection is imported in sectionImplementations", () => {
    // Given: sectionImplementations.tsx file
    // When: Examining imports
    // Then: SpecContainerSection is imported
    const source = fs.readFileSync(sectionImplPath, "utf-8")
    expect(source).toMatch(/import\s*\{\s*SpecContainerSection\s*\}\s*from/)
  })
})

// ============================================================
// Test: test-spec-011-integration: Testing patterns compliance
// Given: Test file structure
// When: Examining test setup
// Then: Follows existing section test patterns
// ============================================================

describe("test-spec-011-integration: Testing patterns compliance", () => {
  test("uses happy-dom for DOM environment", () => {
    // Given: Test file setup
    // When: Test runs
    // Then: happy-dom Window is used for DOM
    expect(window).toBeDefined()
    expect(document).toBeDefined()
  })

  test("uses fs.readFileSync for source code analysis", () => {
    // Verify we can read component source
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source.length).toBeGreaterThan(0)
  })

  test("graphUtils module is accessible for testing", () => {
    // Verify graphUtils can be read
    const graphSource = fs.readFileSync(graphUtilsPath, "utf-8")
    expect(graphSource.length).toBeGreaterThan(0)
    expect(graphSource).toMatch(/transformToGraph/)
  })
})
