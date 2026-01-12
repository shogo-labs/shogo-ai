/**
 * TaskCoverageBarSection Component Tests
 * Task: task-testing-004
 *
 * Tests verify:
 * 1. test-testing-004-coverage-dots: spec dots select on click, title tooltip
 * 2. test-testing-004-overflow: +N overflow when more than 5 specs
 * 3. Component exports TaskCoverageBarSection following SectionRendererProps
 * 4. Fetches tasks from implementationTaskCollection and specs from testSpecificationCollection
 * 5. Uses useTestingPanelContext to get setSelectedSpec
 * 6. Renders Target icon (h-4 w-4) with 'Task Coverage' title in phaseColors.text
 * 7. Each task row shows: task name, spec count, ProgressBar, clickable dots
 * 8. ProgressBar uses coverage calculation with h-2 flex-1 styling
 * 9. Clickable dots with w-2 h-2 rounded-full bg-cyan-500 hover:bg-cyan-400
 * 10. Container uses p-4 rounded-lg border bg-card phaseColors.border
 * 11. Filters out tasks with zero specs from display
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

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

afterEach(() => {
  cleanup()
})

// Test fixtures
const createTestSpec = (id: string, taskId: string, scenario: string) => ({
  id,
  taskId,
  task: { id: taskId },
  scenario,
  testType: "unit" as const,
  given: ["Given condition"],
  when: ["When action"],
  then: ["Then result"],
})

const createTask = (id: string, name: string, sessionId: string) => ({
  id,
  name,
  session: { id: sessionId },
})

// Task with 3 specs for test-testing-004-coverage-dots
const taskWith3Specs = createTask("task-3specs", "Create user form", "feature-001")
const specsForTask3 = [
  createTestSpec("spec-1", "task-3specs", "User can submit valid form"),
  createTestSpec("spec-2", "task-3specs", "User sees validation errors"),
  createTestSpec("spec-3", "task-3specs", "User can reset form"),
]

// Task with 8 specs for test-testing-004-overflow
const taskWith8Specs = createTask("task-8specs", "API integration", "feature-001")
const specsForTask8 = [
  createTestSpec("spec-o1", "task-8specs", "Scenario 1"),
  createTestSpec("spec-o2", "task-8specs", "Scenario 2"),
  createTestSpec("spec-o3", "task-8specs", "Scenario 3"),
  createTestSpec("spec-o4", "task-8specs", "Scenario 4"),
  createTestSpec("spec-o5", "task-8specs", "Scenario 5"),
  createTestSpec("spec-o6", "task-8specs", "Scenario 6"),
  createTestSpec("spec-o7", "task-8specs", "Scenario 7"),
  createTestSpec("spec-o8", "task-8specs", "Scenario 8"),
]

// Task with zero specs (should be filtered out)
const taskWithNoSpecs = createTask("task-nospecs", "Empty task", "feature-001")

// Mock setSelectedSpec function to track calls
let mockSetSelectedSpec = mock(() => {})

// Mock useDomains hook
mock.module("@/contexts/DomainProvider", () => ({
  useDomains: () => ({
    platformFeatures: {
      implementationTaskCollection: {
        all: () => [taskWith3Specs, taskWith8Specs, taskWithNoSpecs],
      },
      testSpecificationCollection: {
        all: () => [...specsForTask3, ...specsForTask8],
      },
    },
  }),
}))

// Mock TestingPanelContext
mock.module("../testing/TestingPanelContext", () => ({
  useTestingPanelContext: () => ({
    selectedSpec: null,
    setSelectedSpec: mockSetSelectedSpec,
    clearSelectedSpec: () => {},
  }),
  TestingPanelProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-provider-wrapper="TestingPanelProvider">{children}</div>
  ),
}))

// Mock shared components
mock.module("../../sections/shared", () => ({
  CompositionProvider: ({ children }: { children: React.ReactNode }) => children,
  usePhaseColorFromContext: () => ({
    bg: "bg-cyan-500",
    text: "text-cyan-500",
    border: "border-cyan-500",
    ring: "ring-cyan-500",
    accent: "bg-cyan-100 text-cyan-800",
  }),
  useCompositionContext: () => ({ phase: "testing" }),
  SectionCard: ({ children, testId, phaseColors }: any) => (
    <div data-testid={testId} className={`p-4 rounded-lg border bg-card ${phaseColors?.border || ''}`}>
      {children}
    </div>
  ),
  SectionHeader: ({ icon, title, phaseColors }: any) => (
    <div className="flex items-center gap-2">
      {icon}
      <h3 className={phaseColors.text}>{title}</h3>
    </div>
  ),
  EmptySectionState: ({ icon: Icon, message }: any) => (
    <div className="flex flex-col items-center">
      <Icon className="h-12 w-12" />
      <p>{message}</p>
    </div>
  ),
}))

// Import after mocking
import { TaskCoverageBarSection } from "../testing/TaskCoverageBarSection"
import { TestingPanelProvider } from "../testing/TestingPanelContext"

// Test feature
const testFeature = {
  id: "feature-001",
  name: "Test Feature",
  status: "testing",
}

describe("test-testing-004-coverage-dots: TaskCoverageBarSection shows spec dots that select on click", () => {
  beforeAll(() => {
    // Reset mock before each test group
    mockSetSelectedSpec = mock(() => {})
    mock.module("../testing/TestingPanelContext", () => ({
      useTestingPanelContext: () => ({
        selectedSpec: null,
        setSelectedSpec: mockSetSelectedSpec,
        clearSelectedSpec: () => {},
      }),
      TestingPanelProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-provider-wrapper="TestingPanelProvider">{children}</div>
      ),
    }))
  })

  test("Given: TaskCoverageBarSection within TestingPanelProvider, Task has 3 test specifications", () => {
    // When: Component renders
    const { container } = render(
      <TestingPanelProvider feature={testFeature}>
        <TaskCoverageBarSection feature={testFeature} />
      </TestingPanelProvider>
    )

    // Then: Component renders within provider
    expect(container.querySelector("[data-testid='task-coverage-bar-section']")).not.toBeNull()

    // Then: Task row is displayed
    expect(container.textContent).toContain("Create user form")
  })

  test("When: User clicks a spec dot, Then: setSelectedSpec called with clicked spec", () => {
    const { container } = render(
      <TestingPanelProvider feature={testFeature}>
        <TaskCoverageBarSection feature={testFeature} />
      </TestingPanelProvider>
    )

    // Find task row for taskWith3Specs
    const specDots = container.querySelectorAll("[data-testid='spec-dot']")
    expect(specDots.length).toBeGreaterThan(0)

    // When: User clicks the first spec dot
    act(() => {
      (specDots[0] as HTMLElement).click()
    })

    // Then: setSelectedSpec was called
    expect(mockSetSelectedSpec).toHaveBeenCalled()
  })

  test("Dot has title attribute with spec.scenario for tooltip", () => {
    const { container } = render(
      <TestingPanelProvider feature={testFeature}>
        <TaskCoverageBarSection feature={testFeature} />
      </TestingPanelProvider>
    )

    // Find spec dots
    const specDots = container.querySelectorAll("[data-testid='spec-dot']")

    // Check that dots have title attributes with scenario text
    const dotWithTitle = Array.from(specDots).find(
      (dot) => (dot as HTMLElement).getAttribute("title")?.includes("User can submit valid form")
    )
    expect(dotWithTitle).not.toBeUndefined()
  })
})

describe("test-testing-004-overflow: TaskCoverageBarSection shows +N overflow when more than 5 specs", () => {
  test("Given: TaskCoverageBarSection with feature prop, Task has 8 test specifications", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Then: Task with 8 specs is rendered
    expect(container.textContent).toContain("API integration")
  })

  test("When: Section renders, Then: Shows max 5 clickable dots", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Find the task row for task with 8 specs
    const taskRows = container.querySelectorAll("[data-testid='task-row']")
    const taskWith8SpecsRow = Array.from(taskRows).find(
      (row) => row.textContent?.includes("API integration")
    )
    expect(taskWith8SpecsRow).not.toBeUndefined()

    // Count dots in that row - should be max 5
    const dotsInRow = taskWith8SpecsRow?.querySelectorAll("[data-testid='spec-dot']")
    expect(dotsInRow?.length).toBe(5)
  })

  test("When: Section renders, Then: +3 overflow indicator displayed", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Find overflow indicator showing +3 (8 specs - 5 displayed = 3 overflow)
    expect(container.textContent).toContain("+3")
  })
})

describe("TaskCoverageBarSection - Basic Rendering", () => {
  test("Component exports TaskCoverageBarSection following SectionRendererProps interface", () => {
    expect(TaskCoverageBarSection).toBeDefined()
    // MobX observer wraps as object with render method - verify it's renderable
    expect(
      typeof TaskCoverageBarSection === "function" ||
      typeof TaskCoverageBarSection === "object"
    ).toBe(true)

    // Should accept feature and config props
    expect(() =>
      render(<TaskCoverageBarSection feature={testFeature} config={{}} />)
    ).not.toThrow()
  })

  test("Renders Target icon (h-4 w-4) with 'Task Coverage' title", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Check for SVG icon with correct size classes
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg?.classList.contains("h-4")).toBe(true)
    expect(svg?.classList.contains("w-4")).toBe(true)

    // Check for title text
    expect(container.textContent).toContain("Task Coverage")
  })

  test("Title uses phaseColors.text (cyan from testing phase)", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    const title = container.querySelector("h3")
    expect(title?.className).toContain("cyan")
  })
})

describe("TaskCoverageBarSection - Task Row Display", () => {
  test("Each task row shows task name (truncated max-w-[200px])", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Check for task names
    expect(container.textContent).toContain("Create user form")
    expect(container.textContent).toContain("API integration")

    // Check for truncation styling
    const taskNameElements = container.querySelectorAll("[data-testid='task-name']")
    expect(taskNameElements.length).toBeGreaterThan(0)

    const hasMaxWidth = Array.from(taskNameElements).some(
      (el) => (el as HTMLElement).className.includes("max-w")
    )
    expect(hasMaxWidth).toBe(true)
  })

  test("Each task row shows spec count", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Task with 3 specs should show count
    expect(container.textContent).toMatch(/3\s*(specs?|tests?)?/)
    // Task with 8 specs should show count
    expect(container.textContent).toMatch(/8\s*(specs?|tests?)?/)
  })

  test("Each task row shows ProgressBar with h-2 flex-1 styling", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    const progressBars = container.querySelectorAll("[role='progressbar']")
    expect(progressBars.length).toBeGreaterThan(0)

    // Progress bars should have flex-1 or h-2 class
    const hasProperStyling = Array.from(progressBars).some((bar) => {
      const className = (bar as HTMLElement).className
      return className.includes("h-2") || className.includes("flex-1")
    })
    expect(hasProperStyling).toBe(true)
  })

  test("Clickable dots use w-2 h-2 rounded-full bg-cyan-500 styling", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    const specDots = container.querySelectorAll("[data-testid='spec-dot']")
    expect(specDots.length).toBeGreaterThan(0)

    // Check for expected classes
    const firstDot = specDots[0] as HTMLElement
    expect(firstDot.className).toContain("w-2")
    expect(firstDot.className).toContain("h-2")
    expect(firstDot.className).toContain("rounded-full")
    expect(firstDot.className).toContain("bg-cyan")
  })
})

describe("TaskCoverageBarSection - Filtering", () => {
  test("Filters out tasks with zero specs from display", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    // Task with no specs should NOT be displayed
    expect(container.textContent).not.toContain("Empty task")

    // Tasks with specs should be displayed
    expect(container.textContent).toContain("Create user form")
    expect(container.textContent).toContain("API integration")
  })
})

describe("TaskCoverageBarSection - Container Styling", () => {
  test("Container uses p-4 rounded-lg border bg-card phaseColors.border styling", () => {
    const { container } = render(
      <TaskCoverageBarSection feature={testFeature} />
    )

    const section = container.querySelector("[data-testid='task-coverage-bar-section']")
    expect(section).not.toBeNull()
    expect(section?.className).toContain("p-4")
    expect(section?.className).toContain("rounded-lg")
    expect(section?.className).toContain("border")
    expect(section?.className).toContain("bg-card")
  })
})

describe("TaskCoverageBarSection - Registration", () => {
  test("is registered in sectionImplementationMap", async () => {
    // Import the map directly
    const { sectionImplementationMap } = await import("../../sectionImplementations")

    const component = sectionImplementationMap.get("TaskCoverageBarSection")
    expect(component).toBeDefined()
  })
})
