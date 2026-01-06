/**
 * ChatHeader Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Shows session name with ChevronDown icon for collapse toggle
 * 2. Shows Loader2 spinner when isLoading is true
 * 3. Calls onToggleCollapse when collapse button is clicked
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import { ChatHeader } from "../ChatHeader"

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
// Test: Session name with collapse toggle (test-2-4-002-011)
// ============================================================
describe("ChatHeader shows session name with collapse toggle", () => {
  test("session name is displayed", () => {
    const { container } = render(
      <ChatHeader
        sessionName="Feature Chat"
        onToggleCollapse={() => {}}
      />
    )

    expect(container.textContent).toContain("Feature Chat")
  })

  test("ChevronDown icon is visible for collapse toggle", () => {
    const { container } = render(
      <ChatHeader
        sessionName="Feature Chat"
        onToggleCollapse={() => {}}
      />
    )

    // Should have ChevronDown icon or a button for collapse
    const chevronIcon = container.querySelector('[data-testid="collapse-icon"]') ||
      container.querySelector('svg') ||
      container.querySelector('button')

    expect(chevronIcon).not.toBeNull()
  })
})

// ============================================================
// Test: Loading spinner (test-2-4-002-012)
// ============================================================
describe("ChatHeader shows loading spinner when isLoading is true", () => {
  test("Loader2 spinner icon is visible", () => {
    const { container } = render(
      <ChatHeader
        sessionName="Feature Chat"
        isLoading={true}
        onToggleCollapse={() => {}}
      />
    )

    // Should have Loader2 spinner with animate-spin class
    const spinner = container.querySelector('[data-testid="loading-spinner"]') ||
      container.querySelector('.animate-spin')

    expect(spinner).not.toBeNull()
  })

  test("session name still displays while loading", () => {
    const { container } = render(
      <ChatHeader
        sessionName="Feature Chat"
        isLoading={true}
        onToggleCollapse={() => {}}
      />
    )

    expect(container.textContent).toContain("Feature Chat")
  })
})

// ============================================================
// Test: Collapse toggle callback (test-2-4-002-013)
// ============================================================
describe("ChatHeader calls onToggleCollapse when collapse button clicked", () => {
  test("onToggleCollapse callback is called", async () => {
    const mockOnToggleCollapse = mock(() => {})
    const { container } = render(
      <ChatHeader
        sessionName="Feature Chat"
        onToggleCollapse={mockOnToggleCollapse}
      />
    )

    // Find the collapse button
    const collapseButton = container.querySelector('[data-testid="collapse-button"]') ||
      container.querySelector('button')

    expect(collapseButton).not.toBeNull()

    await act(async () => {
      fireEvent.click(collapseButton!)
    })

    expect(mockOnToggleCollapse).toHaveBeenCalled()
  })
})
