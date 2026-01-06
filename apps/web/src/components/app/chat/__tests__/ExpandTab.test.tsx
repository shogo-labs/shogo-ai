/**
 * ExpandTab Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Renders vertical Chat label with MessageSquare icon
 * 2. Calls onExpand callback on click
 * 3. Has hover highlight styling
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import { ExpandTab } from "../ExpandTab"

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
// Test: Renders vertical Chat label with MessageSquare icon (test-2-4-002-017)
// ============================================================
describe("ExpandTab renders vertical Chat label with MessageSquare icon", () => {
  test("MessageSquare icon is visible", () => {
    const { container } = render(<ExpandTab onExpand={() => {}} />)

    // Should have an SVG icon (MessageSquare from lucide)
    const icon = container.querySelector('svg') ||
      container.querySelector('[data-testid="message-square-icon"]')

    expect(icon).not.toBeNull()
  })

  test("Chat label is displayed vertically", () => {
    const { container } = render(<ExpandTab onExpand={() => {}} />)

    // Should contain "Chat" text
    expect(container.textContent).toContain("Chat")

    // Should have vertical writing mode or rotation styling
    const tabElement = container.firstChild as HTMLElement
    const hasVerticalStyle =
      tabElement?.className?.includes("writing-mode") ||
      tabElement?.className?.includes("vertical") ||
      tabElement?.className?.includes("rotate") ||
      tabElement?.style?.writingMode?.includes("vertical")

    expect(hasVerticalStyle).toBe(true)
  })
})

// ============================================================
// Test: Calls onExpand when clicked (test-2-4-002-018)
// ============================================================
describe("ExpandTab calls onExpand when clicked", () => {
  test("onExpand callback is called", async () => {
    const mockOnExpand = mock(() => {})
    const { container } = render(<ExpandTab onExpand={mockOnExpand} />)

    const tab = container.firstChild as HTMLElement

    await act(async () => {
      fireEvent.click(tab)
    })

    expect(mockOnExpand).toHaveBeenCalled()
  })
})

// ============================================================
// Test: Hover highlight styling (test-2-4-002-019)
// ============================================================
describe("ExpandTab has hover highlight styling", () => {
  test("component has hover state CSS classes", () => {
    const { container } = render(<ExpandTab onExpand={() => {}} />)

    const tab = container.firstChild as HTMLElement

    // Should have hover styling classes
    const hasHoverStyle =
      tab?.className?.includes("hover:") ||
      tab?.className?.includes("hover-highlight")

    expect(hasHoverStyle).toBe(true)
  })

  test("hover styling provides visual feedback", () => {
    const { container } = render(<ExpandTab onExpand={() => {}} />)

    const tab = container.firstChild as HTMLElement

    // Should have background or color change on hover
    const hasHoverFeedback =
      tab?.className?.includes("hover:bg") ||
      tab?.className?.includes("hover:text") ||
      tab?.className?.includes("hover:border") ||
      tab?.className?.includes("hover:opacity")

    expect(hasHoverFeedback).toBe(true)
  })
})
