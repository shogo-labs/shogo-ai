/**
 * LiveOutputTerminalSection Tests
 * Task: task-implementation-005
 *
 * Tests for the terminal section that displays execution output with syntax coloring.
 * - Reads selectedExecutionId and sortedExecutions from ImplementationPanelContext
 * - Shows terminal-style UI with task name in header
 * - Output colored red for test_failing, green for test_passing
 * - File paths section when testFilePath or implementationFilePath exist
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Mock useDomains hook before importing components
const mockPlatformFeatures = {
  implementationRunCollection: {
    findLatestBySession: mock(() => null),
  },
  taskExecutionCollection: {
    findByRun: mock(() => []),
  },
  implementationTaskCollection: {
    get: mock(() => null),
    findBySession: mock(() => []),
  },
}

mock.module("@/contexts/DomainProvider", () => ({
  useDomains: () => ({ platformFeatures: mockPlatformFeatures }),
}))

// Mock usePhaseColor hook
mock.module("@/hooks/usePhaseColor", () => ({
  usePhaseColor: () => ({
    text: "text-red-500",
    border: "border-red-500",
    bg: "bg-red-500/10",
    gradient: "from-red-500",
  }),
}))

// Import after mocking
import { ImplementationPanelProvider } from "../ImplementationPanelContext"
import { LiveOutputTerminalSection } from "../LiveOutputTerminalSection"

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
  mockPlatformFeatures.implementationTaskCollection.get.mockReset()
  mockPlatformFeatures.implementationTaskCollection.get.mockReturnValue(null)
})

describe("test-impl-005-exports: LiveOutputTerminalSection exports and follows SectionRendererProps interface", () => {
  test("LiveOutputTerminalSection component is exported", () => {
    // observer() wrapped components are objects with render function
    expect(LiveOutputTerminalSection).toBeDefined()
    expect(typeof LiveOutputTerminalSection === "function" || typeof LiveOutputTerminalSection === "object").toBe(true)
  })

  test("Component accepts SectionRendererProps (feature, config)", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])

    // Should render without errors with feature and config props
    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection
          feature={{ id: "feat-1" }}
          config={{ slotId: "terminal" }}
        />
      </ImplementationPanelProvider>
    )

    expect(container.querySelector('[data-testid="live-output-terminal-section"]')).not.toBeNull()
  })
})

describe("test-impl-005-reads-context: Component reads selectedExecutionId and sortedExecutions from context", () => {
  test("Component displays output for selected execution", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-001",
      task: { name: "Create Auth Service" },
      status: "test_passing",
      testOutput: "All tests passed!",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    // Should display the execution output
    expect(container.textContent).toContain("All tests passed!")
  })

  test("If no selectedExecutionId, uses sortedExecutions[0] as fallback", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecutions = [
      { id: "exec-newest", task: { name: "Latest Task" }, status: "test_passing", testOutput: "Latest output", startedAt: 2000 },
      { id: "exec-oldest", task: { name: "Old Task" }, status: "test_failing", testOutput: "Old output", startedAt: 1000 },
    ]

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue(mockExecutions)

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    // Should show output from newest execution (first after sort)
    expect(container.textContent).toContain("Latest output")
  })
})

describe("test-impl-005-empty-state: Component shows empty state when no execution available", () => {
  test("Shows 'Select an execution to view output...' message", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("Select an execution to view output")
  })

  test("Terminal styling maintained in empty state", () => {
    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(null)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const section = container.querySelector('[data-testid="live-output-terminal-section"]')
    expect(section).not.toBeNull()
  })
})

describe("test-impl-005-header: Component shows header with Terminal icon and task name", () => {
  test("Header shows 'Output: {task name}' title", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Create Auth Service" },
      status: "test_passing",
      testOutput: "test output",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("Output:")
    expect(container.textContent).toContain("Create Auth Service")
  })

  test("Header includes Terminal icon", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "output",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const header = container.querySelector('[data-testid="terminal-header"]')
    expect(header).not.toBeNull()
  })
})

describe("test-impl-005-terminal-styling: Terminal body uses correct dark styling", () => {
  test("Terminal body has correct styling", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "test output",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const terminalBody = container.querySelector('[data-testid="terminal-body"]')
    expect(terminalBody).not.toBeNull()
    // Check for terminal styling classes
    expect(terminalBody?.className).toContain("font-mono")
  })
})

describe("test-impl-005-output-color-failing: Output text is red for test_failing status", () => {
  test("Output text uses red-400 color class for failing tests", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_failing",
      testOutput: "FAIL: Test failed with assertion error",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const outputPre = container.querySelector('[data-testid="terminal-output"]')
    expect(outputPre).not.toBeNull()
    expect(outputPre?.className).toContain("red")
  })

  test("testOutput content is displayed in pre tag", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_failing",
      testOutput: "FAIL: Expected true but got false",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("FAIL: Expected true but got false")
  })
})

describe("test-impl-005-output-color-passing: Output text is green for passing status", () => {
  test("Output text uses green-400 color class for passing tests", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "PASS: All tests passed",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const outputPre = container.querySelector('[data-testid="terminal-output"]')
    expect(outputPre).not.toBeNull()
    expect(outputPre?.className).toContain("green")
  })
})

describe("test-impl-005-displays-error: Component displays errorMessage when testOutput is not available", () => {
  test("errorMessage content is displayed when testOutput missing", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "failed",
      errorMessage: "Test runner crashed unexpectedly",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("Test runner crashed unexpectedly")
  })

  test("Error text uses red color styling", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "failed",
      errorMessage: "Crash!",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const outputPre = container.querySelector('[data-testid="terminal-output"]')
    expect(outputPre?.className).toContain("red")
  })
})

describe("test-impl-005-no-output-message: Component shows no output message when neither testOutput nor errorMessage exist", () => {
  test("Message 'No output available' is displayed", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "pending",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("No output available")
  })

  test("Message uses muted styling", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "pending",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const noOutputMessage = container.querySelector('[data-testid="no-output-message"]')
    expect(noOutputMessage).not.toBeNull()
    expect(noOutputMessage?.className).toContain("muted")
  })
})

describe("test-impl-005-file-paths-section: Component shows file paths section when paths exist", () => {
  test("Test file shown with red-400 'TEST:' label", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "output",
      testFilePath: "src/__tests__/auth.test.ts",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("TEST:")
    expect(container.textContent).toContain("src/__tests__/auth.test.ts")
  })

  test("Impl file shown with green-400 'IMPL:' label", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "output",
      implementationFilePath: "src/auth.ts",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    expect(container.textContent).toContain("IMPL:")
    expect(container.textContent).toContain("src/auth.ts")
  })
})

describe("test-impl-005-no-file-paths: Component hides file paths section when no paths exist", () => {
  test("File paths section is not rendered when no paths", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "output",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const filePathsSection = container.querySelector('[data-testid="file-paths-section"]')
    expect(filePathsSection).toBeNull()
  })
})

describe("test-impl-005-phase-colors: Component uses implementation phase colors", () => {
  test("Card border uses phase-consistent colors", () => {
    const mockRun = { id: "run-1", status: "in_progress" }
    const mockExecution = {
      id: "exec-1",
      task: { name: "Test Task" },
      status: "test_passing",
      testOutput: "output",
      startedAt: 1000,
    }

    mockPlatformFeatures.implementationRunCollection.findLatestBySession.mockReturnValue(mockRun)
    mockPlatformFeatures.taskExecutionCollection.findByRun.mockReturnValue([mockExecution])

    const { container } = render(
      <ImplementationPanelProvider feature={{ id: "feat-1" }}>
        <LiveOutputTerminalSection feature={{ id: "feat-1" }} />
      </ImplementationPanelProvider>
    )

    const section = container.querySelector('[data-testid="live-output-terminal-section"]')
    expect(section).not.toBeNull()
    // usePhaseColor mock returns border-red-500
    expect(section?.className).toContain("border")
  })
})

describe("test-impl-005-observer-wrapped: Component is wrapped with observer() for MobX reactivity", () => {
  test("Component is renderable (observer wrapping)", () => {
    // observer() wrapped components can be rendered as React elements
    expect(LiveOutputTerminalSection).toBeDefined()
    // Verify it can be used in JSX by checking it's a valid React component
    expect(typeof LiveOutputTerminalSection === "function" || typeof LiveOutputTerminalSection === "object").toBe(true)
  })
})
