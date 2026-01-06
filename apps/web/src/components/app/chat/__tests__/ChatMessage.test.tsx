/**
 * ChatMessage Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. User messages render with right alignment
 * 2. Assistant messages render with left alignment
 * 3. Streaming state shows typing indicator
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { ChatMessage } from "../ChatMessage"

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
// Test: User Message Rendering (test-2-4-002-001)
// ============================================================
describe("ChatMessage renders user message with right alignment", () => {
  test("message content is displayed", () => {
    const message = {
      id: "msg-1",
      role: "user" as const,
      content: "Hello, assistant!"
    }

    const { container } = render(<ChatMessage message={message} />)

    expect(container.textContent).toContain("Hello, assistant!")
  })

  test("message has right-aligned styling", () => {
    const message = {
      id: "msg-1",
      role: "user" as const,
      content: "Hello, assistant!"
    }

    const { container } = render(<ChatMessage message={message} />)

    // User messages should have right/end alignment classes
    const messageWrapper = container.firstChild as HTMLElement
    expect(messageWrapper?.className).toMatch(/justify-end|items-end|ml-auto|self-end/)
  })

  test("user message has distinct background color", () => {
    const message = {
      id: "msg-1",
      role: "user" as const,
      content: "Hello, assistant!"
    }

    const { container } = render(<ChatMessage message={message} />)

    // User messages typically have primary background
    const messageContent = container.querySelector('[data-testid="message-content"]') || container.firstChild
    expect((messageContent as HTMLElement)?.className).toMatch(/bg-primary|bg-blue|bg-accent/)
  })
})

// ============================================================
// Test: Assistant Message Rendering (test-2-4-002-002)
// ============================================================
describe("ChatMessage renders assistant message with left alignment", () => {
  test("message content is displayed", () => {
    const message = {
      id: "msg-2",
      role: "assistant" as const,
      content: "Hello, I am here to help!"
    }

    const { container } = render(<ChatMessage message={message} />)

    expect(container.textContent).toContain("Hello, I am here to help!")
  })

  test("message has left-aligned styling", () => {
    const message = {
      id: "msg-2",
      role: "assistant" as const,
      content: "Hello, I am here to help!"
    }

    const { container } = render(<ChatMessage message={message} />)

    // Assistant messages should have left/start alignment classes
    const messageWrapper = container.firstChild as HTMLElement
    expect(messageWrapper?.className).toMatch(/justify-start|items-start|mr-auto|self-start/)
  })

  test("assistant message has distinct background color from user", () => {
    const message = {
      id: "msg-2",
      role: "assistant" as const,
      content: "Hello, I am here to help!"
    }

    const { container } = render(<ChatMessage message={message} />)

    // Assistant messages typically have muted/secondary background
    const messageContent = container.querySelector('[data-testid="message-content"]') || container.firstChild
    expect((messageContent as HTMLElement)?.className).toMatch(/bg-muted|bg-secondary|bg-card/)
  })
})

// ============================================================
// Test: Streaming State (test-2-4-002-003)
// ============================================================
describe("ChatMessage shows typing indicator when streaming", () => {
  test("typing indicator or loading animation is visible", () => {
    const message = {
      id: "msg-3",
      role: "assistant" as const,
      content: "I am typing..."
    }

    const { container } = render(<ChatMessage message={message} isStreaming={true} />)

    // Should show some kind of loading indicator
    const typingIndicator = container.querySelector('[data-testid="typing-indicator"]') ||
      container.querySelector('.animate-pulse') ||
      container.querySelector('[aria-label*="typing"]') ||
      container.querySelector('[aria-busy="true"]')

    expect(typingIndicator).not.toBeNull()
  })

  test("message content still displays while streaming", () => {
    const message = {
      id: "msg-3",
      role: "assistant" as const,
      content: "Partial content so far"
    }

    const { container } = render(<ChatMessage message={message} isStreaming={true} />)

    expect(container.textContent).toContain("Partial content so far")
  })
})
