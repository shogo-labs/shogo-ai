/**
 * MessageList Component Tests
 * Task: task-2-4-003 (message-list)
 *
 * Tests verify:
 * 1. MessageList renders array of messages using ChatMessage component
 * 2. MessageList auto-scrolls to bottom when new messages added
 * 3. MessageList shows loading indicator when isLoading is true
 * 4. MessageList handles empty messages array
 * 5. MessageList has overflow-y-auto for scrolling
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { MessageList } from "../MessageList"

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
// Test: MessageList renders array of messages (test-2-4-003-001)
// ============================================================
describe("MessageList renders array of messages using ChatMessage", () => {
  test("each message is rendered as ChatMessage component", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" },
      { id: "msg-2", role: "assistant" as const, content: "Hi there!" },
      { id: "msg-3", role: "user" as const, content: "How are you?" }
    ]

    const { container } = render(<MessageList messages={messages} />)

    // All message contents should be visible
    expect(container.textContent).toContain("Hello!")
    expect(container.textContent).toContain("Hi there!")
    expect(container.textContent).toContain("How are you?")
  })

  test("messages appear in array order", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "First message" },
      { id: "msg-2", role: "assistant" as const, content: "Second message" },
      { id: "msg-3", role: "user" as const, content: "Third message" }
    ]

    const { container } = render(<MessageList messages={messages} />)

    const textContent = container.textContent || ""
    const firstIndex = textContent.indexOf("First message")
    const secondIndex = textContent.indexOf("Second message")
    const thirdIndex = textContent.indexOf("Third message")

    expect(firstIndex).toBeLessThan(secondIndex)
    expect(secondIndex).toBeLessThan(thirdIndex)
  })
})

// ============================================================
// Test: MessageList auto-scrolls to bottom (test-2-4-003-002)
// ============================================================
describe("MessageList auto-scrolls to bottom when new messages added", () => {
  test("scrollIntoView behavior is triggered on new message", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" },
      { id: "msg-2", role: "assistant" as const, content: "Hi there!" }
    ]

    const { container, rerender } = render(<MessageList messages={messages} />)

    // Find the scroll anchor element (should be at bottom)
    const scrollAnchor = container.querySelector('[data-testid="scroll-anchor"]')

    // Mock scrollIntoView if it exists
    if (scrollAnchor) {
      const scrollIntoViewMock = mock(() => {})
      ;(scrollAnchor as HTMLElement).scrollIntoView = scrollIntoViewMock

      // Add a new message
      const updatedMessages = [
        ...messages,
        { id: "msg-3", role: "user" as const, content: "New message!" }
      ]
      rerender(<MessageList messages={updatedMessages} />)

      // scrollIntoView should have been called
      expect(scrollIntoViewMock).toHaveBeenCalled()
    } else {
      // If no scroll anchor, the component should still render without error
      expect(container.textContent).toContain("Hello!")
    }
  })

  test("list scrolls to show new message at bottom", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" }
    ]

    const { container, rerender } = render(<MessageList messages={messages} />)

    // The component should have a scroll anchor at the end
    let scrollAnchor = container.querySelector('[data-testid="scroll-anchor"]')
    expect(scrollAnchor).not.toBeNull()

    // Add new message
    const updatedMessages = [
      ...messages,
      { id: "msg-2", role: "assistant" as const, content: "New response!" }
    ]
    rerender(<MessageList messages={updatedMessages} />)

    // Scroll anchor should still be present
    scrollAnchor = container.querySelector('[data-testid="scroll-anchor"]')
    expect(scrollAnchor).not.toBeNull()
  })
})

// ============================================================
// Test: MessageList shows loading indicator (test-2-4-003-003)
// ============================================================
describe("MessageList shows loading indicator when isLoading is true", () => {
  test("loading indicator appears at bottom of list", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" }
    ]

    const { container } = render(<MessageList messages={messages} isLoading={true} />)

    // Should show loading indicator
    const loadingIndicator = container.querySelector('[data-testid="loading-indicator"]') ||
      container.querySelector('.animate-pulse') ||
      container.querySelector('[aria-label*="loading"]') ||
      container.querySelector('[aria-busy="true"]')

    expect(loadingIndicator).not.toBeNull()
  })

  test("existing messages still visible when loading", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" },
      { id: "msg-2", role: "assistant" as const, content: "Hi there!" }
    ]

    const { container } = render(<MessageList messages={messages} isLoading={true} />)

    // All messages should still be visible
    expect(container.textContent).toContain("Hello!")
    expect(container.textContent).toContain("Hi there!")
  })

  test("no loading indicator when isLoading is false", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" }
    ]

    const { container } = render(<MessageList messages={messages} isLoading={false} />)

    // Should not show loading indicator
    const loadingIndicator = container.querySelector('[data-testid="loading-indicator"]')
    expect(loadingIndicator).toBeNull()
  })
})

// ============================================================
// Test: MessageList handles empty messages array (test-2-4-003-004)
// ============================================================
describe("MessageList handles empty messages array", () => {
  test("appropriate empty state is displayed", () => {
    const { container } = render(<MessageList messages={[]} />)

    // Should show empty state message or element
    const emptyState = container.querySelector('[data-testid="empty-state"]') ||
      container.textContent?.match(/no messages|start a conversation|empty/i)

    expect(emptyState).not.toBeNull()
  })

  test("no error is thrown with empty array", () => {
    // Should not throw error
    expect(() => {
      render(<MessageList messages={[]} />)
    }).not.toThrow()
  })
})

// ============================================================
// Test: MessageList has overflow-y-auto for scrolling (test-2-4-003-005)
// ============================================================
describe("MessageList has overflow-y-auto for scrolling", () => {
  test("container has overflow-y-auto CSS class", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" }
    ]

    const { container } = render(<MessageList messages={messages} />)

    // The main container should have overflow-y-auto for vertical scrolling
    const listContainer = container.firstChild as HTMLElement
    expect(listContainer?.className).toMatch(/overflow-y-auto|overflow-auto/)
  })

  test("vertical scrolling is enabled", () => {
    const messages = [
      { id: "msg-1", role: "user" as const, content: "Hello!" }
    ]

    const { container } = render(<MessageList messages={messages} />)

    // Container should allow vertical scrolling
    const listContainer = container.firstChild as HTMLElement
    // Check for overflow class or direct style
    const hasOverflow = listContainer?.className.includes('overflow') ||
      listContainer?.style?.overflowY === 'auto'

    expect(hasOverflow).toBe(true)
  })
})
