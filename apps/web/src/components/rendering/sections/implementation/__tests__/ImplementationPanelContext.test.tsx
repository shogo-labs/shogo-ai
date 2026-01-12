/**
 * ImplementationPanelContext Tests
 * Task: task-implementation-001
 *
 * Tests for the Implementation phase panel context that provides:
 * - selectedExecutionId state for cross-section coordination
 * - latestRun derived from platformFeatures domain
 * - sortedExecutions array from taskExecutionCollection
 * - currentTDDStage computed from run/execution status
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Mock useDomains hook before importing the context
const mockPlatformFeatures = {
  implementationRunCollection: {
    findLatestBySession: mock(() => null),
  },
  taskExecutionCollection: {
    findByRun: mock(() => []),
  },
  implementationTaskCollection: {
    get: mock(() => null),
  },
}

mock.module("@/contexts/DomainProvider", () => ({
  useDomains: () => ({ platformFeatures: mockPlatformFeatures }),
}))

// Import after mocking
import {
  ImplementationPanelProvider,
  useImplementationPanelContext,
  type ImplementationPanelState,
} from "../ImplementationPanelContext"

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
  // Reset mocks
  mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReset()
  mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(null)
  mockPlatformFeatures.taskExecutionCollection.findByRun.mockReset()
  mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])
})

describe("test-impl-001-provider-exports: ImplementationPanelContext exports Provider and hook", () => {
  test("ImplementationPanelProvider component is exported", () => {
    expect(typeof ImplementationPanelProvider).toBe("function")
  })

  test("useImplementationPanelContext hook is exported", () => {
    expect(typeof useImplementationPanelContext).toBe("function")
  })
})

describe("test-impl-001-provider-renders: ImplementationPanelProvider renders children", () => {
  test("Provider wraps child component and renders", () => {
    // Given: ImplementationPanelProvider component is imported
    // When: Provider wraps child component and renders
    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <div data-testid="child">Child Content</div>
      </ImplementationPanelProvider>
    )

    // Then: Child component is rendered within Provider
    expect(container.textContent).toContain("Child Content")
  })

  test("Provider has data-provider-wrapper attribute for identification", () => {
    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <div>Content</div>
      </ImplementationPanelProvider>
    )

    // Then: Provider has data-provider-wrapper attribute for identification
    const wrapper = container.querySelector('[data-provider-wrapper="ImplementationPanelProvider"]')
    expect(wrapper).not.toBeNull()
  })
})

describe("test-impl-001-default-state: Context provides default state with null selectedExecutionId", () => {
  test("selectedExecutionId is null by default", () => {
    // Given: Consumer component uses useImplementationPanelContext wrapped in Provider
    let contextValue: ImplementationPanelState | null = null

    function Consumer() {
      contextValue = useImplementationPanelContext()
      return <div data-testid="consumer">Consumed</div>
    }

    // When: Consumer accesses context state
    render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: selectedExecutionId is null by default
    expect(contextValue!.selectedExecutionId).toBeNull()
  })

  test("setSelectedExecutionId function is available", () => {
    let contextValue: ImplementationPanelState | null = null

    function Consumer() {
      contextValue = useImplementationPanelContext()
      return null
    }

    render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: setSelectedExecutionId function is available
    expect(typeof contextValue!.setSelectedExecutionId).toBe("function")
  })

  test("clearSelectedExecutionId function is available", () => {
    let contextValue: ImplementationPanelState | null = null

    function Consumer() {
      contextValue = useImplementationPanelContext()
      return null
    }

    render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: clearSelectedExecutionId function is available
    expect(typeof contextValue!.clearSelectedExecutionId).toBe("function")
  })
})

describe("test-impl-001-set-execution: setSelectedExecutionId updates selectedExecutionId state", () => {
  test("setSelectedExecutionId updates to provided value", () => {
    // Given: Consumer is wrapped in ImplementationPanelProvider, selectedExecutionId is initially null
    function Consumer() {
      const { selectedExecutionId, setSelectedExecutionId } = useImplementationPanelContext()
      return (
        <div>
          <span data-testid="selected">{selectedExecutionId ?? "null"}</span>
          <button
            data-testid="select"
            onClick={() => setSelectedExecutionId("exec-123")}
          >
            Select
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Initially null
    expect(getByTestId("selected").textContent).toBe("null")

    // When: setSelectedExecutionId('exec-123') is called
    act(() => {
      getByTestId("select").click()
    })

    // Then: selectedExecutionId updates to 'exec-123', Consuming components re-render with new value
    expect(getByTestId("selected").textContent).toBe("exec-123")
  })
})

describe("test-impl-001-clear-execution: clearSelectedExecutionId resets selectedExecutionId to null", () => {
  test("clearSelectedExecutionId resets selection", () => {
    // Given: Consumer is wrapped in ImplementationPanelProvider, selectedExecutionId is set to 'exec-123'
    function Consumer() {
      const { selectedExecutionId, setSelectedExecutionId, clearSelectedExecutionId } =
        useImplementationPanelContext()
      return (
        <div>
          <span data-testid="selected">{selectedExecutionId ?? "null"}</span>
          <button
            data-testid="select"
            onClick={() => setSelectedExecutionId("exec-123")}
          >
            Select
          </button>
          <button
            data-testid="clear"
            onClick={() => clearSelectedExecutionId()}
          >
            Clear
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Select first
    act(() => {
      getByTestId("select").click()
    })
    expect(getByTestId("selected").textContent).toBe("exec-123")

    // When: clearSelectedExecutionId() is called
    act(() => {
      getByTestId("clear").click()
    })

    // Then: selectedExecutionId resets to null, Consuming components re-render with null value
    expect(getByTestId("selected").textContent).toBe("null")
  })
})

describe("test-impl-001-hook-throws: useImplementationPanelContext throws when used outside Provider", () => {
  test("throws descriptive error when used outside Provider", () => {
    // Given: Consumer component uses useImplementationPanelContext NOT wrapped in Provider
    function BadConsumer() {
      useImplementationPanelContext()
      return null
    }

    // Suppress console.error for this test
    const originalError = console.error
    console.error = () => {}

    // When/Then: Consumer attempts to render, Error is thrown with descriptive message
    expect(() => render(<BadConsumer />)).toThrow(
      "useImplementationPanelContext must be used within ImplementationPanelProvider"
    )

    console.error = originalError
  })
})

describe("test-impl-001-exposes-latest-run: Context exposes latestRun from platformFeatures domain", () => {
  test("latestRun contains the most recent ImplementationRun", () => {
    // Given: ImplementationPanelProvider wraps consumer with feature prop
    //        Feature has implementation runs in platformFeatures.implementationRunCollection
    const mockRun = { id: "run-1", status: "in_progress", completedTasks: [] }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)

    let contextValue: ImplementationPanelState | null = null

    function Consumer() {
      contextValue = useImplementationPanelContext()
      return <span data-testid="run">{contextValue.latestRun?.id ?? "null"}</span>
    }

    // When: Consumer accesses latestRun from context
    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: latestRun contains the most recent ImplementationRun for the feature
    expect(getByTestId("run").textContent).toBe("run-1")
  })

  test("latestRun is undefined when no runs exist", () => {
    // Given: Feature has no implementation runs
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(null)

    function Consumer() {
      const { latestRun } = useImplementationPanelContext()
      return <span data-testid="run">{latestRun?.id ?? "null"}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: latestRun is undefined when no runs exist
    expect(getByTestId("run").textContent).toBe("null")
  })
})

describe("test-impl-001-exposes-sorted-executions: Context exposes sortedExecutions array", () => {
  test("sortedExecutions is an array of TaskExecution entities", () => {
    // Given: ImplementationPanelProvider wraps consumer with feature prop
    //        latestRun has multiple TaskExecution entities
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecutions = [
      { id: "exec-1", startedAt: 1000, status: "test_passing" },
      { id: "exec-2", startedAt: 2000, status: "test_failing" },
    ]

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue(mockExecutions)

    function Consumer() {
      const { sortedExecutions } = useImplementationPanelContext()
      return <span data-testid="count">{sortedExecutions.length}</span>
    }

    // When: Consumer accesses sortedExecutions from context
    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: sortedExecutions is an array of TaskExecution entities
    expect(getByTestId("count").textContent).toBe("2")
  })

  test("executions are sorted by startedAt descending (newest first)", () => {
    // Given: Multiple executions with different startedAt times
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecutions = [
      { id: "exec-old", startedAt: 1000, status: "test_passing" },
      { id: "exec-new", startedAt: 2000, status: "test_failing" },
    ]

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue(mockExecutions)

    function Consumer() {
      const { sortedExecutions } = useImplementationPanelContext()
      return (
        <div data-testid="order">
          {sortedExecutions.map((e, i) => (
            <span key={e.id} data-testid={`exec-${i}`}>
              {e.id}
            </span>
          ))}
        </div>
      )
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Executions are sorted by startedAt descending (newest first)
    expect(getByTestId("exec-0").textContent).toBe("exec-new")
    expect(getByTestId("exec-1").textContent).toBe("exec-old")
  })

  test("empty array returned when no executions exist", () => {
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(null)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])

    function Consumer() {
      const { sortedExecutions } = useImplementationPanelContext()
      return <span data-testid="count">{sortedExecutions.length}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Empty array returned when no executions exist
    expect(getByTestId("count").textContent).toBe("0")
  })
})

describe("test-impl-001-computes-tdd-stage: Context computes currentTDDStage from run and execution status", () => {
  test("returns 'idle' when no run exists", () => {
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(null)

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'idle' when no run exists
    expect(getByTestId("stage").textContent).toBe("idle")
  })

  test("returns 'pending' when run is in_progress but no execution started", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'pending' when run is in_progress but no execution started
    expect(getByTestId("stage").textContent).toBe("pending")
  })

  test("returns 'test_failing' when most recent execution has test_failing status", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecutions = [
      { id: "exec-1", startedAt: 2000, status: "test_failing" },
      { id: "exec-2", startedAt: 1000, status: "test_passing" },
    ]

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue(mockExecutions)

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'test_failing' when most recent execution has test_failing status
    expect(getByTestId("stage").textContent).toBe("test_failing")
  })

  test("returns 'test_passing' when most recent execution has test_passing status", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecutions = [{ id: "exec-1", startedAt: 2000, status: "test_passing" }]

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue(mockExecutions)

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'test_passing' when most recent execution has test_passing status
    expect(getByTestId("stage").textContent).toBe("test_passing")
  })

  test("returns 'complete' when run status is complete", () => {
    const mockRun = { id: "run-1", status: "complete" }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'complete' when run status is complete
    expect(getByTestId("stage").textContent).toBe("complete")
  })

  test("returns 'failed' when run status is failed", () => {
    const mockRun = { id: "run-1", status: "failed" }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)

    function Consumer() {
      const { currentTDDStage } = useImplementationPanelContext()
      return <span data-testid="stage">{currentTDDStage}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer />
      </ImplementationPanelProvider>
    )

    // Then: Returns 'failed' when run status is failed
    expect(getByTestId("stage").textContent).toBe("failed")
  })
})

describe("test-impl-001-cross-section-state: Multiple consumers share the same selectedExecutionId state", () => {
  test("both consumers see the same state update", () => {
    // Given: Two consumer components both use useImplementationPanelContext
    //        Both consumers are wrapped in same ImplementationPanelProvider
    function Consumer1() {
      const { selectedExecutionId, setSelectedExecutionId } = useImplementationPanelContext()
      return (
        <div>
          <span data-testid="c1-selected">{selectedExecutionId ?? "null"}</span>
          <button
            data-testid="c1-select"
            onClick={() => setSelectedExecutionId("exec-456")}
          >
            Select
          </button>
        </div>
      )
    }

    function Consumer2() {
      const { selectedExecutionId } = useImplementationPanelContext()
      return <span data-testid="c2-selected">{selectedExecutionId ?? "null"}</span>
    }

    const { getByTestId } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <Consumer1 />
        <Consumer2 />
      </ImplementationPanelProvider>
    )

    // Both start with null
    expect(getByTestId("c1-selected").textContent).toBe("null")
    expect(getByTestId("c2-selected").textContent).toBe("null")

    // When: First consumer calls setSelectedExecutionId('exec-456')
    act(() => {
      getByTestId("c1-select").click()
    })

    // Then: First consumer sees selectedExecutionId as 'exec-456'
    //       Second consumer also sees selectedExecutionId as 'exec-456'
    //       Both consumers update synchronously
    expect(getByTestId("c1-selected").textContent).toBe("exec-456")
    expect(getByTestId("c2-selected").textContent).toBe("exec-456")
  })
})
