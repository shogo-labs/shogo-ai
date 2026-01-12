/**
 * AnalysisPanelContext Tests
 * Task: task-analysis-001
 *
 * Tests verify:
 * 1. Uses createPanelContext factory
 * 2. Exports AnalysisPanelProvider and useAnalysisPanelContext hook
 * 3. State includes viewMode: 'matrix' | 'list' with default 'matrix'
 * 4. State includes activeFilter: { type: FindingType | null, location: string | null }
 * 5. Provides setViewMode, setActiveFilter, and clearFilter functions
 * 6. Hook throws descriptive error when used outside Provider
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"
import {
  AnalysisPanelProvider,
  useAnalysisPanelContext,
  type AnalysisPanelState,
} from "../AnalysisPanelContext"

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

describe("AnalysisPanelContext - Provider", () => {
  test("Provider renders children", () => {
    const { container } = render(
      <AnalysisPanelProvider>
        <div data-testid="child">Child Content</div>
      </AnalysisPanelProvider>
    )

    expect(container.textContent).toContain("Child Content")
  })

  test("Provider has data attribute for identification", () => {
    const { container } = render(
      <AnalysisPanelProvider>
        <div>Content</div>
      </AnalysisPanelProvider>
    )

    const provider = container.querySelector("[data-provider-wrapper='AnalysisPanelProvider']")
    expect(provider).not.toBeNull()
  })
})

describe("AnalysisPanelContext - Default State", () => {
  test("viewMode defaults to 'matrix'", () => {
    let state: AnalysisPanelState | null = null
    function Consumer() {
      state = useAnalysisPanelContext()
      return null
    }

    render(
      <AnalysisPanelProvider>
        <Consumer />
      </AnalysisPanelProvider>
    )

    expect(state).not.toBeNull()
    expect(state!.viewMode).toBe("matrix")
  })

  test("activeFilter defaults to { type: null, location: null }", () => {
    let state: AnalysisPanelState | null = null
    function Consumer() {
      state = useAnalysisPanelContext()
      return null
    }

    render(
      <AnalysisPanelProvider>
        <Consumer />
      </AnalysisPanelProvider>
    )

    expect(state!.activeFilter).toEqual({ type: null, location: null })
  })
})

describe("AnalysisPanelContext - State Updates", () => {
  test("setViewMode updates viewMode", () => {
    function TestComponent() {
      const { viewMode, setViewMode } = useAnalysisPanelContext()
      return (
        <div>
          <span data-testid="mode">{viewMode}</span>
          <button onClick={() => setViewMode("list")}>Set List</button>
        </div>
      )
    }

    const { container, getByRole } = render(
      <AnalysisPanelProvider>
        <TestComponent />
      </AnalysisPanelProvider>
    )

    expect(container.textContent).toContain("matrix")

    act(() => {
      getByRole("button").click()
    })

    expect(container.textContent).toContain("list")
  })

  test("setActiveFilter updates activeFilter", () => {
    function TestComponent() {
      const { activeFilter, setActiveFilter } = useAnalysisPanelContext()
      return (
        <div>
          <span data-testid="filter">
            {activeFilter.type ?? "none"}-{activeFilter.location ?? "none"}
          </span>
          <button onClick={() => setActiveFilter({ type: "pattern", location: "web" })}>
            Set Filter
          </button>
        </div>
      )
    }

    const { container, getByRole } = render(
      <AnalysisPanelProvider>
        <TestComponent />
      </AnalysisPanelProvider>
    )

    expect(container.textContent).toContain("none-none")

    act(() => {
      getByRole("button").click()
    })

    expect(container.textContent).toContain("pattern-web")
  })

  test("clearFilter resets activeFilter to nulls", () => {
    function TestComponent() {
      const { activeFilter, setActiveFilter, clearFilter } = useAnalysisPanelContext()
      return (
        <div>
          <span data-testid="filter">
            {activeFilter.type ?? "none"}-{activeFilter.location ?? "none"}
          </span>
          <button data-testid="set" onClick={() => setActiveFilter({ type: "gap", location: "api" })}>
            Set
          </button>
          <button data-testid="clear" onClick={clearFilter}>
            Clear
          </button>
        </div>
      )
    }

    const { container, getByTestId } = render(
      <AnalysisPanelProvider>
        <TestComponent />
      </AnalysisPanelProvider>
    )

    // Set filter first
    act(() => {
      getByTestId("set").click()
    })
    expect(container.textContent).toContain("gap-api")

    // Clear filter
    act(() => {
      getByTestId("clear").click()
    })
    expect(container.textContent).toContain("none-none")
  })
})

describe("AnalysisPanelContext - Error Handling", () => {
  test("throws descriptive error when used outside Provider", () => {
    function BadConsumer() {
      useAnalysisPanelContext()
      return null
    }

    // Suppress console.error for this test
    const originalError = console.error
    console.error = () => {}

    expect(() => render(<BadConsumer />)).toThrow(
      "useAnalysisPanelContext must be used within AnalysisPanelProvider"
    )

    console.error = originalError
  })
})

describe("AnalysisPanelContext - Cross-Section Coordination", () => {
  test("multiple consumers share the same state", () => {
    function Header() {
      const { viewMode, setViewMode } = useAnalysisPanelContext()
      return (
        <div data-testid="header">
          <span data-testid="header-mode">{viewMode}</span>
          <button data-testid="toggle" onClick={() => setViewMode(viewMode === "matrix" ? "list" : "matrix")}>
            Toggle
          </button>
        </div>
      )
    }

    function Content() {
      const { viewMode, activeFilter, setActiveFilter } = useAnalysisPanelContext()
      return (
        <div data-testid="content">
          <span data-testid="content-mode">{viewMode}</span>
          <span data-testid="content-filter">{activeFilter.type ?? "none"}</span>
          <button data-testid="filter-btn" onClick={() => setActiveFilter({ type: "risk", location: null })}>
            Filter
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <AnalysisPanelProvider>
        <Header />
        <Content />
      </AnalysisPanelProvider>
    )

    // Both see same initial state
    expect(getByTestId("header-mode").textContent).toBe("matrix")
    expect(getByTestId("content-mode").textContent).toBe("matrix")

    // Header toggles, Content sees change
    act(() => {
      getByTestId("toggle").click()
    })
    expect(getByTestId("header-mode").textContent).toBe("list")
    expect(getByTestId("content-mode").textContent).toBe("list")

    // Content filters, both can see (if needed)
    act(() => {
      getByTestId("filter-btn").click()
    })
    expect(getByTestId("content-filter").textContent).toBe("risk")
  })
})
