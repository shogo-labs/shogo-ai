/**
 * Tests for TaskDetailsPanel
 * Task: task-spec-005
 *
 * TDD tests for the TaskDetailsPanel internal sub-component:
 * - Function component accepts { task: Task | null, integrationPoints: IntegrationPoint[], onClose: () => void }
 * - Returns null when task is null
 * - Panel styling: w-80 border-l border-emerald-500/20 bg-card p-4 overflow-auto
 * - Header with task name and close button (X icon)
 * - Status section using PropertyRenderer with statusPropertyMeta (xRenderer: task-status-badge)
 * - Description section when task.description exists
 * - Acceptance criteria section using PropertyRenderer with acceptanceCriteriaPropertyMeta (xRenderer: string-array)
 * - IntegrationPointsSection with filtered integration points (ip.task === task.id)
 * - Dependencies section showing task.dependencies as emerald-colored badges
 *
 * Test Specification: test-spec-005-details-panel
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
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

afterAll(() => {
  cleanup_dom()
})

afterEach(() => {
  cleanup()
})

const componentPath = path.resolve(
  import.meta.dir,
  "../TaskDetailsPanel.tsx"
)

// ============================================================
// Test: test-spec-005-details-panel - Component file and exports
// Given: TaskDetailsPanel component file should exist
// When: Component is imported
// Then: Component exports TaskDetailsPanel function
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel component file and exports", () => {
  test("component file exists at expected path", () => {
    // Given: TaskDetailsPanel component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("TaskDetailsPanel is exported", () => {
    // Given: Component should be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+TaskDetailsPanel/)
  })

  test("component accepts task, integrationPoints, and onClose props", () => {
    // Given: Component should accept required props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/task/)
    expect(source).toMatch(/integrationPoints/)
    expect(source).toMatch(/onClose/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - TaskDetailsPanelProps interface
// Given: TaskDetailsPanelProps interface definition
// When: Checking interface structure
// Then: Interface has task: Task | null, integrationPoints: IntegrationPoint[], onClose: () => void
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanelProps interface", () => {
  test("defines TaskDetailsPanelProps interface", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/interface\s+TaskDetailsPanelProps/)
  })

  test("task prop is Task | null", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/task:\s*Task\s*\|\s*null/)
  })

  test("integrationPoints prop has array type with task field", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // integrationPoints should be typed to include task field for filtering
    // Implementation uses IntegrationPointWithTask[] which extends IntegrationPoint
    expect(source).toMatch(/integrationPoints:/)
    expect(source).toMatch(/IntegrationPointWithTask\[\]/)
  })

  test("onClose prop is () => void", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onClose:\s*\(\s*\)\s*=>\s*void/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Returns null when task is null
// Given: TaskDetailsPanel with task=null
// When: Component renders
// Then: Component returns null (does not render anything)
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel returns null when task is null", () => {
  test("component checks for null task", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have early return for null task
    expect(source).toMatch(/return\s+null/)
    // Should check if task is null/falsy
    expect(source).toMatch(/!task|task\s*===\s*null/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Panel styling
// Given: TaskDetailsPanel with valid task
// When: Component renders
// Then: Panel has w-80 border-l border-emerald-500/20 bg-card p-4 overflow-auto classes
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel panel styling", () => {
  test("panel has w-80 class for fixed width", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/w-80/)
  })

  test("panel has border-l class for left border", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-l/)
  })

  test("panel has border-emerald-500/20 for emerald border color", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-emerald-500\/20/)
  })

  test("panel has bg-card for background", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/bg-card/)
  })

  test("panel has p-4 for padding", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/p-4/)
  })

  test("panel has overflow-auto for scrolling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/overflow-auto/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Header with task name and close button
// Given: TaskDetailsPanel with valid task
// When: Component renders
// Then: Header shows task name and X close button
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel header", () => {
  test("imports X icon from lucide-react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Note: Use [\s\S]* for multiline import matching
    expect(source).toMatch(/import[\s\S]*X[\s\S]*from\s*["']lucide-react["']/)
  })

  test("header displays task.name", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/task\.name/)
  })

  test("close button with X icon calls onClose", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have X icon
    expect(source).toMatch(/<X/)
    // Should call onClose on click
    expect(source).toMatch(/onClick.*onClose|onClose.*onClick/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Status section with PropertyRenderer
// Given: TaskDetailsPanel with valid task
// When: Component renders
// Then: Status section uses PropertyRenderer with xRenderer: task-status-badge
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel status section", () => {
  test("imports PropertyRenderer", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*PropertyRenderer/)
  })

  test("defines statusPropertyMeta with xRenderer: task-status-badge", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define property metadata for status
    expect(source).toMatch(/statusPropertyMeta|status.*PropertyMetadata/)
    expect(source).toMatch(/xRenderer:\s*["']task-status-badge["']/)
  })

  test("renders status with PropertyRenderer", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use PropertyRenderer with status value
    expect(source).toMatch(/<PropertyRenderer[\s\S]*?task\.status/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Description section
// Given: TaskDetailsPanel with valid task that has description
// When: Component renders
// Then: Description section shows task.description
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel description section", () => {
  test("renders description when task.description exists", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should conditionally render based on task.description
    expect(source).toMatch(/task\.description/)
  })

  test("description section is conditional", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering for description
    expect(source).toMatch(/task\.description\s*&&|\{task\.description\s*\?/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Acceptance criteria section with PropertyRenderer
// Given: TaskDetailsPanel with valid task that has acceptanceCriteria
// When: Component renders
// Then: Acceptance criteria section uses PropertyRenderer with xRenderer: string-array
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel acceptance criteria section", () => {
  test("defines acceptanceCriteriaPropertyMeta with xRenderer: string-array", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define property metadata for acceptance criteria
    expect(source).toMatch(/acceptanceCriteriaPropertyMeta|acceptanceCriteria.*PropertyMetadata/)
    expect(source).toMatch(/xRenderer:\s*["']string-array["']/)
  })

  test("renders acceptance criteria with PropertyRenderer", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use PropertyRenderer with acceptanceCriteria value
    expect(source).toMatch(/<PropertyRenderer[\s\S]*?acceptanceCriteria/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - IntegrationPointsSection
// Given: TaskDetailsPanel with valid task and integrationPoints
// When: Component renders
// Then: IntegrationPointsSection receives filtered integration points (ip.task === task.id)
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel integration points section", () => {
  test("imports IntegrationPointsSection", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*IntegrationPointsSection/)
  })

  test("filters integrationPoints by task.id", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should filter integration points where ip.task === task.id
    expect(source).toMatch(/integrationPoints\.filter|filteredIntegrationPoints/)
    expect(source).toMatch(/\.task\s*===\s*task\.id|ip\.task|integrationPoint\.task/)
  })

  test("renders IntegrationPointsSection with filtered points", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<IntegrationPointsSection/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Dependencies section
// Given: TaskDetailsPanel with valid task that has dependencies
// When: Component renders
// Then: Dependencies section shows task.dependencies as emerald-colored badges
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel dependencies section", () => {
  test("renders dependencies when task.dependencies exists", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should access task.dependencies
    expect(source).toMatch(/task\.dependencies/)
  })

  test("maps over dependencies to render badges", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should map over dependencies array
    expect(source).toMatch(/dependencies\.map|task\.dependencies\.map/)
  })

  test("dependency badges use emerald color", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Dependencies should use emerald coloring
    expect(source).toMatch(/emerald/)
    // Should have badge-like styling
    expect(source).toMatch(/bg-emerald|text-emerald/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Task interface
// Given: TaskDetailsPanel component
// When: Checking type definitions
// Then: Task interface is defined with required fields
// ============================================================

describe("test-spec-005-details-panel: Task interface definition", () => {
  test("defines Task interface or imports it", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have Task type (interface definition or import)
    expect(source).toMatch(/interface\s+Task|type\s+Task|import.*Task/)
  })

  test("Task has id, name, status fields", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Task should have id, name, status at minimum
    expect(source).toMatch(/id:\s*string/)
    expect(source).toMatch(/name:\s*string/)
    expect(source).toMatch(/status:\s*string/)
  })

  test("Task has optional description field", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Task should have optional description
    expect(source).toMatch(/description\?:\s*string/)
  })

  test("Task has acceptanceCriteria field", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Task should have acceptanceCriteria
    expect(source).toMatch(/acceptanceCriteria/)
  })

  test("Task has dependencies field", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Task should have dependencies
    expect(source).toMatch(/dependencies/)
  })
})

// ============================================================
// Test: test-spec-005-details-panel - Rendering behavior tests
// Given: TaskDetailsPanel with mock data
// When: Component renders
// Then: All expected elements are present
// ============================================================

describe("test-spec-005-details-panel: TaskDetailsPanel rendering behavior", () => {
  // Mock dependencies to isolate component
  mock.module("./IntegrationPointsSection", () => ({
    IntegrationPointsSection: ({ integrationPoints }: { integrationPoints: unknown[] }) => (
      <div data-testid="mock-integration-points-section">
        {integrationPoints.length} points
      </div>
    ),
  }))

  mock.module("@/components/rendering/PropertyRenderer", () => ({
    PropertyRenderer: ({ property, value }: { property: { name: string }; value: unknown }) => (
      <div data-testid={`mock-property-renderer-${property.name}`}>
        {String(value)}
      </div>
    ),
  }))

  mock.module("@/components/rendering/ComponentRegistryContext", () => ({
    useComponentRegistry: () => ({
      resolve: () => ({ component: () => null }),
      getEntry: () => null,
    }),
  }))

  test("renders null when task is null", async () => {
    const { TaskDetailsPanel } = await import("../TaskDetailsPanel")

    const { container } = render(
      <TaskDetailsPanel
        task={null}
        integrationPoints={[]}
        onClose={() => {}}
      />
    )

    // Should render nothing (null)
    expect(container.firstChild).toBeNull()
  })

  test("renders panel when task is provided", async () => {
    const { TaskDetailsPanel } = await import("../TaskDetailsPanel")

    const mockTask = {
      id: "task-001",
      name: "Test Task",
      status: "planned",
      description: "A test task description",
      acceptanceCriteria: ["Criterion 1", "Criterion 2"],
      dependencies: ["dep-001", "dep-002"],
    }

    const { container, getByText } = render(
      <TaskDetailsPanel
        task={mockTask}
        integrationPoints={[]}
        onClose={() => {}}
      />
    )

    // Should render something
    expect(container.firstChild).not.toBeNull()

    // Should show task name
    expect(container.textContent).toContain("Test Task")
  })

  test("close button calls onClose when clicked", async () => {
    const { TaskDetailsPanel } = await import("../TaskDetailsPanel")

    let closeCalled = false
    const mockTask = {
      id: "task-001",
      name: "Test Task",
      status: "planned",
      acceptanceCriteria: [],
      dependencies: [],
    }

    const { container } = render(
      <TaskDetailsPanel
        task={mockTask}
        integrationPoints={[]}
        onClose={() => { closeCalled = true }}
      />
    )

    // Find and click the close button
    const closeButton = container.querySelector("button")
    if (closeButton) {
      fireEvent.click(closeButton)
    }

    expect(closeCalled).toBe(true)
  })

  test("filters integration points by task.id", async () => {
    const { TaskDetailsPanel } = await import("../TaskDetailsPanel")

    const mockTask = {
      id: "task-001",
      name: "Test Task",
      status: "planned",
      acceptanceCriteria: [],
      dependencies: [],
    }

    const mockIntegrationPoints = [
      { id: "ip-001", name: "IP 1", task: "task-001", filePath: "/test1", description: "test" },
      { id: "ip-002", name: "IP 2", task: "task-002", filePath: "/test2", description: "test" },
      { id: "ip-003", name: "IP 3", task: "task-001", filePath: "/test3", description: "test" },
    ]

    const { container } = render(
      <TaskDetailsPanel
        task={mockTask}
        integrationPoints={mockIntegrationPoints}
        onClose={() => {}}
      />
    )

    // Should show only 2 integration points (IP 1 and IP 3 for task-001)
    // IntegrationPointsSection shows "(2)" in the header for count
    expect(container.textContent).toContain("(2)")
    // Should show IP 1 and IP 3, but not IP 2 (different task)
    expect(container.textContent).toContain("IP 1")
    expect(container.textContent).toContain("IP 3")
    expect(container.textContent).not.toContain("IP 2")
  })

  test("renders dependencies as badges", async () => {
    const { TaskDetailsPanel } = await import("../TaskDetailsPanel")

    const mockTask = {
      id: "task-001",
      name: "Test Task",
      status: "planned",
      acceptanceCriteria: [],
      dependencies: ["dep-001", "dep-002"],
    }

    const { container } = render(
      <TaskDetailsPanel
        task={mockTask}
        integrationPoints={[]}
        onClose={() => {}}
      />
    )

    // Should show dependency values
    expect(container.textContent).toContain("dep-001")
    expect(container.textContent).toContain("dep-002")
  })
})
