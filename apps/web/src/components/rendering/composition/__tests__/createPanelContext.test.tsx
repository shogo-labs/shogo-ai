/**
 * createPanelContext Factory Tests
 * Task: task-prephase-001
 *
 * Tests verify:
 * 1. Factory function returns { Provider, useContext, contextName }
 * 2. Generated Provider accepts children and optional initialState props
 * 3. Generated hook returns { selectedItem, setSelectedItem, clearSelectedItem }
 * 4. Hook throws descriptive error when used outside Provider
 * 5. Supports generic TSelectedItem type for different selection types
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React, { useState } from "react"
import { createPanelContext, type PanelContextValue } from "../createPanelContext"

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

describe("createPanelContext - Factory Return Value", () => {
  test("returns Provider, useContext, and contextName", () => {
    // When: Creating a panel context
    const result = createPanelContext<string>("TestPanel")

    // Then: Returns expected structure
    expect(result.Provider).toBeDefined()
    expect(typeof result.Provider).toBe("function")
    expect(result.useContext).toBeDefined()
    expect(typeof result.useContext).toBe("function")
    expect(result.contextName).toBe("TestPanel")
  })
})

describe("createPanelContext - Provider Component", () => {
  test("Provider renders children", () => {
    const { Provider } = createPanelContext<string>("Test")

    const { container } = render(
      <Provider>
        <div data-testid="child">Child Content</div>
      </Provider>
    )

    expect(container.textContent).toContain("Child Content")
  })

  test("Provider accepts initialState prop", () => {
    const { Provider, useContext } = createPanelContext<string>("Test")

    function Consumer() {
      const { selectedItem } = useContext()
      return <div data-testid="selected">{selectedItem ?? "none"}</div>
    }

    const { container } = render(
      <Provider initialState="initial-value">
        <Consumer />
      </Provider>
    )

    expect(container.textContent).toContain("initial-value")
  })

  test("Provider defaults selectedItem to null when no initialState", () => {
    const { Provider, useContext } = createPanelContext<string>("Test")

    function Consumer() {
      const { selectedItem } = useContext()
      return <div data-testid="selected">{selectedItem ?? "null"}</div>
    }

    const { container } = render(
      <Provider>
        <Consumer />
      </Provider>
    )

    expect(container.textContent).toContain("null")
  })
})

describe("createPanelContext - useContext Hook", () => {
  test("returns selectedItem, setSelectedItem, and clearSelectedItem", () => {
    const { Provider, useContext } = createPanelContext<string>("Test")

    let contextValue: PanelContextValue<string> | null = null
    function Consumer() {
      contextValue = useContext()
      return null
    }

    render(
      <Provider>
        <Consumer />
      </Provider>
    )

    expect(contextValue).not.toBeNull()
    expect(contextValue!.selectedItem).toBeNull()
    expect(typeof contextValue!.setSelectedItem).toBe("function")
    expect(typeof contextValue!.clearSelectedItem).toBe("function")
  })

  test("setSelectedItem updates selectedItem", () => {
    const { Provider, useContext } = createPanelContext<string>("Test")

    function TestComponent() {
      const { selectedItem, setSelectedItem } = useContext()
      return (
        <div>
          <span data-testid="value">{selectedItem ?? "none"}</span>
          <button onClick={() => setSelectedItem("new-value")}>Set</button>
        </div>
      )
    }

    const { container, getByRole } = render(
      <Provider>
        <TestComponent />
      </Provider>
    )

    expect(container.textContent).toContain("none")

    act(() => {
      getByRole("button").click()
    })

    expect(container.textContent).toContain("new-value")
  })

  test("clearSelectedItem resets to null", () => {
    const { Provider, useContext } = createPanelContext<string>("Test")

    function TestComponent() {
      const { selectedItem, setSelectedItem, clearSelectedItem } = useContext()
      return (
        <div>
          <span data-testid="value">{selectedItem ?? "none"}</span>
          <button data-testid="set" onClick={() => setSelectedItem("value")}>Set</button>
          <button data-testid="clear" onClick={clearSelectedItem}>Clear</button>
        </div>
      )
    }

    const { container, getByTestId } = render(
      <Provider>
        <TestComponent />
      </Provider>
    )

    // Set a value first
    act(() => {
      getByTestId("set").click()
    })
    expect(container.textContent).toContain("value")

    // Clear it
    act(() => {
      getByTestId("clear").click()
    })
    expect(container.textContent).toContain("none")
  })

  test("throws descriptive error when used outside Provider", () => {
    const { useContext } = createPanelContext<string>("TestPanel")

    function BadConsumer() {
      useContext() // This should throw
      return null
    }

    // Suppress console.error for this test since we expect an error
    const originalError = console.error
    console.error = () => {}

    expect(() => render(<BadConsumer />)).toThrow(
      "useTestPanelContext must be used within TestPanelProvider"
    )

    console.error = originalError
  })
})

describe("createPanelContext - Generic Type Support", () => {
  test("works with object types", () => {
    interface TestSpec {
      id: string
      scenario: string
    }

    const { Provider, useContext } = createPanelContext<TestSpec>("TestSpec")

    function Consumer() {
      const { selectedItem, setSelectedItem } = useContext()
      return (
        <div>
          <span data-testid="id">{selectedItem?.id ?? "none"}</span>
          <button
            onClick={() => setSelectedItem({ id: "spec-1", scenario: "Test scenario" })}
          >
            Set
          </button>
        </div>
      )
    }

    const { container, getByRole } = render(
      <Provider>
        <Consumer />
      </Provider>
    )

    expect(container.textContent).toContain("none")

    act(() => {
      getByRole("button").click()
    })

    expect(container.textContent).toContain("spec-1")
  })

  test("works with filter object types (for Analysis)", () => {
    interface FindingFilter {
      type: string | null
      location: string | null
    }

    const { Provider, useContext } = createPanelContext<FindingFilter>("AnalysisFilter")

    function Consumer() {
      const { selectedItem, setSelectedItem, clearSelectedItem } = useContext()
      return (
        <div>
          <span data-testid="filter">
            {selectedItem ? `${selectedItem.type}-${selectedItem.location}` : "none"}
          </span>
          <button
            data-testid="set"
            onClick={() => setSelectedItem({ type: "pattern", location: "web" })}
          >
            Set Filter
          </button>
          <button data-testid="clear" onClick={clearSelectedItem}>
            Clear
          </button>
        </div>
      )
    }

    const { container, getByTestId } = render(
      <Provider>
        <Consumer />
      </Provider>
    )

    expect(container.textContent).toContain("none")

    act(() => {
      getByTestId("set").click()
    })

    expect(container.textContent).toContain("pattern-web")

    act(() => {
      getByTestId("clear").click()
    })

    expect(container.textContent).toContain("none")
  })
})

describe("createPanelContext - Multiple Contexts", () => {
  test("multiple contexts are isolated", () => {
    const context1 = createPanelContext<string>("Context1")
    const context2 = createPanelContext<string>("Context2")

    function Consumer1() {
      const { selectedItem } = context1.useContext()
      return <span data-testid="c1">{selectedItem ?? "c1-none"}</span>
    }

    function Consumer2() {
      const { selectedItem } = context2.useContext()
      return <span data-testid="c2">{selectedItem ?? "c2-none"}</span>
    }

    const { container } = render(
      <context1.Provider initialState="value1">
        <context2.Provider initialState="value2">
          <Consumer1 />
          <Consumer2 />
        </context2.Provider>
      </context1.Provider>
    )

    expect(container.textContent).toContain("value1")
    expect(container.textContent).toContain("value2")
  })
})
