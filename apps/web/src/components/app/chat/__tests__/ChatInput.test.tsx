/**
 * ChatInput Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Renders textarea with submit button
 * 2. Calls onSubmit with content and clears input
 * 3. Disables textarea and button when disabled prop is true
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import { ChatInput } from "../ChatInput"

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
// Test: Renders textarea with submit button (test-2-4-002-008)
// ============================================================
describe("ChatInput renders textarea with submit button", () => {
  test("textarea element is present", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
  })

  test("submit button is present", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const button = container.querySelector('button[type="submit"]') ||
      container.querySelector('button')
    expect(button).not.toBeNull()
  })

  test("uses shadcn styling", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const textarea = container.querySelector("textarea")
    // Should have shadcn textarea styling classes
    expect(textarea?.className).toMatch(/rounded|border|focus/)
  })
})

// ============================================================
// Test: Calls onSubmit with content (test-2-4-002-009)
// ============================================================
describe("ChatInput calls onSubmit with content when submitted", () => {
  test("onSubmit is called with textarea content on button click", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    const button = container.querySelector("button")!

    // Type content - set value directly for uncontrolled component
    textarea.value = "Hello, world!"

    // Click submit
    await act(async () => {
      fireEvent.click(button)
    })

    expect(mockOnSubmit).toHaveBeenCalledWith("Hello, world!")
  })

  test("onSubmit is called on Enter key press (without Shift)", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Type content - set value directly for uncontrolled component
    textarea.value = "Test message"

    // Press Enter
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    })

    expect(mockOnSubmit).toHaveBeenCalledWith("Test message")
  })

  test("textarea is cleared after submit", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    const button = container.querySelector("button")!

    // Type content - set value directly for uncontrolled component
    textarea.value = "To be cleared"
    expect(textarea.value).toBe("To be cleared")

    // Submit
    await act(async () => {
      fireEvent.click(button)
    })

    // Should be cleared
    expect(textarea.value).toBe("")
  })
})

// ============================================================
// Test: Disabled state (test-2-4-002-010)
// ============================================================
describe("ChatInput disables textarea and button when disabled prop is true", () => {
  test("textarea has disabled attribute", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const textarea = container.querySelector("textarea")
    expect(textarea?.hasAttribute("disabled")).toBe(true)
  })

  test("submit button has disabled attribute", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const button = container.querySelector("button")
    expect(button?.hasAttribute("disabled")).toBe(true)
  })

  test("visual styling indicates disabled state", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const textarea = container.querySelector("textarea")
    const button = container.querySelector("button")

    // Should have disabled styling (opacity, cursor)
    expect(textarea?.className).toMatch(/disabled|opacity|cursor-not-allowed/)
    expect(button?.className).toMatch(/disabled|opacity|pointer-events-none/)
  })
})
