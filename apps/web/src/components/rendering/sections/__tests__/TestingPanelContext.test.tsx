/**
 * TestingPanelContext Tests
 * Task: task-testing-001
 *
 * Tests verify:
 * 1. TestingPanelProvider and useTestingPanelContext hook exports
 * 2. selectedSpec state with default null value
 * 3. setSelectedSpec function for TaskCoverageBarSection
 * 4. clearSelectedSpec function for ScenarioSpotlightSection close button
 * 5. Provider wraps children and initializes state
 * 6. Hook throws descriptive error if used outside Provider
 * 7. State updates propagate between sections
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"
import {
  TestingPanelProvider,
  useTestingPanelContext,
  type TestingPanelState,
} from "../testing/TestingPanelContext"

// TestSpec type representing TestSpecification from platform-features schema
interface TestSpec {
  id: string
  taskId: string
  scenario: string
  testType: "unit" | "integration" | "acceptance"
  given: string[]
  when: string[]
  then: string[]
}

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// Sample test spec for testing
const sampleTestSpec: TestSpec = {
  id: "test-spec-001",
  taskId: "task-001",
  scenario: "User can submit form with valid data",
  testType: "unit",
  given: ["A valid form state", "User is authenticated"],
  when: ["User clicks submit button"],
  then: ["Form data is sent to API", "Success message is displayed"],
}

const anotherTestSpec: TestSpec = {
  id: "test-spec-002",
  taskId: "task-001",
  scenario: "User sees error for invalid data",
  testType: "integration",
  given: ["An invalid form state"],
  when: ["User clicks submit button"],
  then: ["Validation errors are displayed"],
}

describe("test-testing-001-context: TestingPanelContext provides selectedSpec state to sections", () => {
  test("TestingPanelProvider wraps child sections and hook returns state", () => {
    // Given: TestingPanelProvider wraps child sections, Initial selectedSpec is null
    let contextValue: TestingPanelState | null = null

    function Consumer() {
      contextValue = useTestingPanelContext()
      return <div data-testid="consumer">Consumed</div>
    }

    // When: Child section calls useTestingPanelContext()
    const { container } = render(
      <TestingPanelProvider>
        <Consumer />
      </TestingPanelProvider>
    )

    // Then: Hook returns selectedSpec with null value
    expect(contextValue).not.toBeNull()
    expect(contextValue!.selectedSpec).toBeNull()

    // Then: Hook returns setSelectedSpec function
    expect(typeof contextValue!.setSelectedSpec).toBe("function")

    // Then: Hook returns clearSelectedSpec function
    expect(typeof contextValue!.clearSelectedSpec).toBe("function")

    // Verify Provider rendered children
    expect(container.textContent).toContain("Consumed")
  })

  test("Provider initializes selectedSpec to null by default", () => {
    // Given: TestingPanelProvider wraps child sections
    function Consumer() {
      const { selectedSpec } = useTestingPanelContext()
      return <div data-testid="spec">{selectedSpec?.id ?? "null"}</div>
    }

    // When: Provider renders without initial state
    const { container } = render(
      <TestingPanelProvider>
        <Consumer />
      </TestingPanelProvider>
    )

    // Then: selectedSpec is null
    expect(container.textContent).toContain("null")
  })

  test("Hook throws descriptive error if used outside Provider", () => {
    // Given: A component that uses the hook without Provider
    function BadConsumer() {
      useTestingPanelContext()
      return null
    }

    // Suppress console.error for this test since we expect an error
    const originalError = console.error
    console.error = () => {}

    // When/Then: Rendering throws with descriptive error
    expect(() => render(<BadConsumer />)).toThrow(
      "useTestingPanelContext must be used within TestingPanelProvider"
    )

    console.error = originalError
  })
})

describe("test-testing-001-propagate: TestingPanelContext state updates propagate between sections", () => {
  test("setSelectedSpec updates state accessible to all consumers", () => {
    // Given: TestingPanelProvider wraps TaskCoverageBarSection and ScenarioSpotlightSection
    function TaskCoverageBarSection() {
      const { setSelectedSpec } = useTestingPanelContext()
      return (
        <button
          data-testid="task-coverage"
          onClick={() => setSelectedSpec(sampleTestSpec)}
        >
          Select Spec
        </button>
      )
    }

    function ScenarioSpotlightSection() {
      const { selectedSpec, clearSelectedSpec } = useTestingPanelContext()
      return (
        <div data-testid="scenario-spotlight">
          <span data-testid="selected-id">{selectedSpec?.id ?? "none"}</span>
          <span data-testid="selected-scenario">{selectedSpec?.scenario ?? "none"}</span>
          <button data-testid="close" onClick={clearSelectedSpec}>
            Close
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <TestingPanelProvider>
        <TaskCoverageBarSection />
        <ScenarioSpotlightSection />
      </TestingPanelProvider>
    )

    // Initially, selectedSpec is null
    expect(getByTestId("selected-id").textContent).toBe("none")
    expect(getByTestId("selected-scenario").textContent).toBe("none")

    // When: TaskCoverageBarSection calls setSelectedSpec(testSpec)
    act(() => {
      getByTestId("task-coverage").click()
    })

    // Then: ScenarioSpotlightSection receives updated selectedSpec
    expect(getByTestId("selected-id").textContent).toBe("test-spec-001")
    expect(getByTestId("selected-scenario").textContent).toBe(
      "User can submit form with valid data"
    )
  })

  test("clearSelectedSpec resets state to null", () => {
    // Given: A provider with a selected spec
    function TaskCoverageBarSection() {
      const { setSelectedSpec } = useTestingPanelContext()
      return (
        <button
          data-testid="select"
          onClick={() => setSelectedSpec(sampleTestSpec)}
        >
          Select
        </button>
      )
    }

    function ScenarioSpotlightSection() {
      const { selectedSpec, clearSelectedSpec } = useTestingPanelContext()
      return (
        <div>
          <span data-testid="id">{selectedSpec?.id ?? "none"}</span>
          <button data-testid="close" onClick={clearSelectedSpec}>
            Close
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <TestingPanelProvider>
        <TaskCoverageBarSection />
        <ScenarioSpotlightSection />
      </TestingPanelProvider>
    )

    // Select a spec first
    act(() => {
      getByTestId("select").click()
    })
    expect(getByTestId("id").textContent).toBe("test-spec-001")

    // When: ScenarioSpotlightSection calls clearSelectedSpec
    act(() => {
      getByTestId("close").click()
    })

    // Then: selectedSpec is reset to null
    expect(getByTestId("id").textContent).toBe("none")
  })

  test("Both sections re-render with new state when spec changes", () => {
    // Given: Provider with multiple sections
    let taskCoverageRenderCount = 0
    let spotlightRenderCount = 0

    function TaskCoverageBarSection() {
      taskCoverageRenderCount++
      const { selectedSpec, setSelectedSpec } = useTestingPanelContext()
      return (
        <div>
          <span data-testid="task-selected">{selectedSpec?.id ?? "none"}</span>
          <button
            data-testid="select-1"
            onClick={() => setSelectedSpec(sampleTestSpec)}
          >
            Select 1
          </button>
          <button
            data-testid="select-2"
            onClick={() => setSelectedSpec(anotherTestSpec)}
          >
            Select 2
          </button>
        </div>
      )
    }

    function ScenarioSpotlightSection() {
      spotlightRenderCount++
      const { selectedSpec } = useTestingPanelContext()
      return (
        <span data-testid="spotlight-selected">{selectedSpec?.id ?? "none"}</span>
      )
    }

    const { getByTestId } = render(
      <TestingPanelProvider>
        <TaskCoverageBarSection />
        <ScenarioSpotlightSection />
      </TestingPanelProvider>
    )

    const initialTaskRenders = taskCoverageRenderCount
    const initialSpotlightRenders = spotlightRenderCount

    // When: Selecting first spec
    act(() => {
      getByTestId("select-1").click()
    })

    // Then: Both sections show same state
    expect(getByTestId("task-selected").textContent).toBe("test-spec-001")
    expect(getByTestId("spotlight-selected").textContent).toBe("test-spec-001")

    // When: Selecting second spec
    act(() => {
      getByTestId("select-2").click()
    })

    // Then: Both sections update to new state
    expect(getByTestId("task-selected").textContent).toBe("test-spec-002")
    expect(getByTestId("spotlight-selected").textContent).toBe("test-spec-002")

    // Both sections should have re-rendered
    expect(taskCoverageRenderCount).toBeGreaterThan(initialTaskRenders)
    expect(spotlightRenderCount).toBeGreaterThan(initialSpotlightRenders)
  })
})

describe("TestingPanelContext - Provider Props", () => {
  test("Provider receives feature prop for context data", () => {
    // Given: A feature object
    const mockFeature = { id: "feat-001", name: "Test Feature" }

    function Consumer() {
      const ctx = useTestingPanelContext()
      return <div>{ctx.selectedSpec?.id ?? "none"}</div>
    }

    // When: Provider is rendered with feature prop
    const { container } = render(
      <TestingPanelProvider feature={mockFeature}>
        <Consumer />
      </TestingPanelProvider>
    )

    // Then: Provider renders successfully
    expect(container.textContent).toContain("none")
  })

  test("Provider has data-provider-wrapper attribute for testing", () => {
    function Consumer() {
      return <div>Child</div>
    }

    const { container } = render(
      <TestingPanelProvider>
        <Consumer />
      </TestingPanelProvider>
    )

    // Then: Provider wrapper has data attribute
    const wrapper = container.querySelector('[data-provider-wrapper="TestingPanelProvider"]')
    expect(wrapper).not.toBeNull()
  })
})
