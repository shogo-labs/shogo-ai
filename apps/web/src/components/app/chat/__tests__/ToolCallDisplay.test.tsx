/**
 * ToolCallDisplay Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Renders input-streaming state with streaming indicator
 * 2. Renders input-available state with args displayed
 * 3. Renders output-available state with result displayed
 * 4. Renders output-error state with destructive styling
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { ToolCallDisplay } from "../ToolCallDisplay"

// Set up happy-dom
import { Window } from "happy-dom"

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

// ============================================================
// Test: Input-Streaming State (test-2-4-002-004)
// ============================================================
describe("ToolCallDisplay renders input-streaming state", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("streaming indicator is visible", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    // Should show streaming/loading indicator
    const indicator = container.querySelector('[data-testid="streaming-indicator"]') ||
      container.querySelector('.animate-pulse') ||
      container.querySelector('[aria-busy="true"]')

    expect(indicator).not.toBeNull()
  })

  test("args not yet shown when streaming", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    // Args section should not be visible during input streaming
    const argsSection = container.querySelector('[data-testid="tool-args"]')
    expect(argsSection).toBeNull()
  })
})

// ============================================================
// Test: Input-Available State (test-2-4-002-005)
// ============================================================
describe("ToolCallDisplay renders input-available state with args", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco", units: "celsius" }}
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("args are displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco", units: "celsius" }}
      />
    )

    // Args should be visible
    expect(container.textContent).toContain("location")
    expect(container.textContent).toContain("San Francisco")
  })

  test("executing indicator shown", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco" }}
      />
    )

    // Should show executing/pending indicator
    const indicator = container.querySelector('[data-testid="executing-indicator"]') ||
      container.querySelector('.animate-spin') ||
      container.textContent?.toLowerCase().includes("executing") ||
      container.textContent?.toLowerCase().includes("running")

    expect(indicator).toBeTruthy()
  })
})

// ============================================================
// Test: Output-Available State (test-2-4-002-006)
// ============================================================
describe("ToolCallDisplay renders output-available state with result", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72, condition: "sunny" }}
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("result is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72, condition: "sunny" }}
      />
    )

    // Result should be visible
    expect(container.textContent).toContain("72")
    expect(container.textContent).toContain("sunny")
  })

  test("success styling applied", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72 }}
      />
    )

    // Should have success/positive styling (green or check icon)
    const wrapper = container.firstChild as HTMLElement
    const hasSuccessStyle =
      wrapper?.className?.includes("border-green") ||
      wrapper?.className?.includes("text-green") ||
      container.querySelector('[data-testid="success-icon"]') ||
      container.querySelector('[data-state="success"]')

    expect(hasSuccessStyle).toBeTruthy()
  })
})

// ============================================================
// Test: Output-Error State (test-2-4-002-007)
// ============================================================
describe("ToolCallDisplay renders output-error state with destructive styling", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("error message is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    expect(container.textContent).toContain("Location not found")
  })

  test("destructive/red border styling applied", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    // Should have destructive/error styling (red)
    const wrapper = container.firstChild as HTMLElement
    const hasDestructiveStyle =
      wrapper?.className?.includes("border-red") ||
      wrapper?.className?.includes("border-destructive") ||
      wrapper?.className?.includes("text-red") ||
      wrapper?.className?.includes("text-destructive") ||
      container.querySelector('[data-state="error"]')

    expect(hasDestructiveStyle).toBeTruthy()
  })
})
