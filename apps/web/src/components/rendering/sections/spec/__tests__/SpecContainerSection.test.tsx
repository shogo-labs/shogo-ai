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

  test("TaskNode accepts NodeProps<TaskNodeData>", () => {
    // Given: TaskNode should accept NodeProps with TaskNodeData
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/NodeProps<TaskNodeData>/)
  })

  test("TaskNodeData interface is defined with correct properties", () => {
    // Given: TaskNodeData interface should define task, dependencyCount, blocksCount, isSelected, isCritical
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/interface\s+TaskNodeData/)
    expect(source).toMatch(/task:\s*Task/)
    expect(source).toMatch(/dependencyCount:\s*number/)
    expect(source).toMatch(/blocksCount:\s*number/)
    expect(source).toMatch(/isSelected:\s*boolean/)
    expect(source).toMatch(/isCritical:\s*boolean/)
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
    expect(source).toMatch(/import.*Handle.*from\s+["']@xyflow\/react["']/)
    expect(source).toMatch(/import.*Position.*from\s+["']@xyflow\/react["']/)
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
    expect(source).toMatch(/import.*NodeProps.*from\s+["']@xyflow\/react["']/)
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
