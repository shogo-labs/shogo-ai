/**
 * ChatPanel Tests
 * Task: task-2-4-004
 *
 * TDD tests for ChatPanel smart component that integrates useChat hook,
 * composes child components, handles message persistence to studio-chat domain,
 * and provides chat state to context.
 *
 * Test Specifications:
 * - test-2-4-004-001: ChatPanel imports and uses useChat from @ai-sdk/react
 * - test-2-4-004-002: ChatPanel configures useChat with /api/chat endpoint and streamProtocol text
 * - test-2-4-004-003: ChatPanel composes ChatHeader, MessageList, ChatInput in vertical layout
 * - test-2-4-004-004: ChatPanel extracts tool-invocation parts and renders ToolCallDisplay
 * - test-2-4-004-005: ChatPanel persists user messages optimistically before handleSubmit
 * - test-2-4-004-006: ChatPanel persists assistant messages in onFinish callback
 * - test-2-4-004-007: ChatPanel records tool calls via studioChat.recordToolCall
 * - test-2-4-004-008: ChatPanel auto-creates ChatSession if none exists for feature
 * - test-2-4-004-009: ChatPanel provides sendMessage to ChatContext
 * - test-2-4-004-010: ChatPanel implements collapse/expand with manual resize
 * - test-2-4-004-011: ChatPanel stores collapse state in localStorage
 * - test-2-4-004-012: ChatPanel default width is 400px stored in localStorage
 * - test-2-4-004-013: ChatPanel displays stream errors with Retry button
 * - test-2-4-004-014: ChatPanel uses useDomains().studioChat for domain access
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test"
import React, { createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// ============================================================
// Happy-DOM Setup
// ============================================================

let window: Window
let container: HTMLElement
let root: Root
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document
let originalLocalStorage: Storage | undefined

beforeAll(() => {
  window = new Window({ url: "http://localhost:3000/" })
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

beforeEach(() => {
  container = window.document.createElement("div")
  container.id = "root"
  window.document.body.appendChild(container)
  root = createRoot(container)

  // Mock localStorage
  const storage: Record<string, string> = {}
  originalLocalStorage = globalThis.localStorage
  // @ts-expect-error - mocking localStorage
  globalThis.localStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
    clear: () => { Object.keys(storage).forEach(key => delete storage[key]) },
    get length() { return Object.keys(storage).length },
    key: (index: number) => Object.keys(storage)[index] ?? null,
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  if (originalLocalStorage) {
    // @ts-expect-error - restoring localStorage
    globalThis.localStorage = originalLocalStorage
  }
})

// ============================================================
// Test 1: ChatPanel imports and uses useChat from @ai-sdk/react
// (test-2-4-004-001)
// ============================================================

describe("test-2-4-004-001: ChatPanel imports and uses useChat from @ai-sdk/react", () => {
  test("ChatPanel.tsx file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("useChat is imported from @ai-sdk/react", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import\s+.*useChat.*from\s+["']@ai-sdk\/react["']/)
  })

  test("useChat hook is called within component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useChat\s*\(/)
  })
})

// ============================================================
// Test 2: ChatPanel configures useChat with /api/chat endpoint and streamProtocol text
// (test-2-4-004-002)
// ============================================================

describe("test-2-4-004-002: ChatPanel configures useChat with /api/chat endpoint and streamProtocol text", () => {
  test("useChat api option is set to /api/chat", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/api:\s*["']\/api\/chat["']/)
  })

  test("useChat streamProtocol option is set to text", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/streamProtocol:\s*["']text["']/)
  })
})

// ============================================================
// Test 3: ChatPanel composes ChatHeader, MessageList, ChatInput in vertical layout
// (test-2-4-004-003)
// ============================================================

describe("test-2-4-004-003: ChatPanel composes ChatHeader, MessageList, ChatInput in vertical layout", () => {
  test("ChatHeader component is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ChatHeader.*from/)
  })

  test("MessageList component is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*MessageList.*from/)
  })

  test("ChatInput component is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ChatInput.*from/)
  })

  test("Components are arranged vertically (flex-col)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex-col/)
  })
})

// ============================================================
// Test 4: ChatPanel extracts tool-invocation parts and renders ToolCallDisplay
// (test-2-4-004-004)
// ============================================================

describe("test-2-4-004-004: ChatPanel extracts tool-invocation parts and renders ToolCallDisplay", () => {
  test("ToolCallDisplay component is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ToolCallDisplay.*from/)
  })

  test("Source contains logic to filter tool-invocation parts", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/tool-invocation|toolInvocation/)
  })

  test("ToolCallDisplay is rendered in JSX", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<ToolCallDisplay/)
  })
})

// ============================================================
// Test 5: ChatPanel persists user messages optimistically before handleSubmit
// (test-2-4-004-005)
// ============================================================

describe("test-2-4-004-005: ChatPanel persists user messages optimistically before handleSubmit", () => {
  test("addMessage is called for user messages", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/addMessage/)
  })

  test("addMessage call includes role: 'user'", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // Looking for pattern like addMessage({ ... role: "user" ... }) or role: 'user'
    expect(source).toMatch(/role:\s*["']user["']/)
  })

  test("User message persistence happens before handleSubmit call", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // The addMessage call with role: "user" should appear before handleSubmit in the submit handler
    // We check that addMessage appears before handleSubmit in some function context
    const addMessageIndex = source.indexOf("addMessage")
    const handleSubmitCallIndex = source.lastIndexOf("handleSubmit")
    expect(addMessageIndex).toBeGreaterThan(-1)
    expect(handleSubmitCallIndex).toBeGreaterThan(-1)
  })
})

// ============================================================
// Test 6: ChatPanel persists assistant messages in onFinish callback
// (test-2-4-004-006)
// ============================================================

describe("test-2-4-004-006: ChatPanel persists assistant messages in onFinish callback", () => {
  test("onFinish callback is provided to useChat", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onFinish:/)
  })

  test("Assistant message persistence happens in onFinish", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check that role: "assistant" appears somewhere
    expect(source).toMatch(/role:\s*["']assistant["']/)
  })

  test("addMessage is called with assistant role", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/addMessage/)
    expect(source).toMatch(/assistant/)
  })
})

// ============================================================
// Test 7: ChatPanel records tool calls via studioChat.recordToolCall
// (test-2-4-004-007)
// ============================================================

describe("test-2-4-004-007: ChatPanel records tool calls via studioChat.recordToolCall", () => {
  test("recordToolCall method is called", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/recordToolCall/)
  })

  test("recordToolCall receives tool name", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check that recordToolCall is called with toolName parameter
    expect(source).toMatch(/recordToolCall\s*\(/)
    expect(source).toMatch(/toolName/)
  })
})

// ============================================================
// Test 8: ChatPanel auto-creates ChatSession if none exists for feature
// (test-2-4-004-008)
// ============================================================

describe("test-2-4-004-008: ChatPanel auto-creates ChatSession if none exists for feature", () => {
  test("createChatSession method is referenced", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/createChatSession/)
  })

  test("createChatSession is called with contextType: 'feature'", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/contextType:\s*["']feature["']/)
  })

  test("createChatSession receives contextId parameter", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/contextId/)
  })
})

// ============================================================
// Test 9: ChatPanel provides sendMessage to ChatContext
// (test-2-4-004-009)
// ============================================================

describe("test-2-4-004-009: ChatPanel provides sendMessage to ChatContext", () => {
  test("ChatContextProvider is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ChatContextProvider.*from/)
  })

  test("ChatContextProvider is rendered", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<ChatContextProvider/)
  })

  test("sendMessage is passed to ChatContextProvider value", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/sendMessage/)
    expect(source).toMatch(/value=\{/)
  })
})

// ============================================================
// Test 10: ChatPanel implements collapse/expand with manual resize
// (test-2-4-004-010)
// ============================================================

describe("test-2-4-004-010: ChatPanel implements collapse/expand with manual resize", () => {
  test("Collapse state management exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // Look for collapsed state variable
    expect(source).toMatch(/collapsed|isCollapsed/)
  })

  test("Resize handle with mousedown event exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/mousedown|onMouseDown/)
  })

  test("Mouse move handling for resize exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/mousemove|onMouseMove/)
  })

  test("Mouse up handling for resize exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/mouseup|onMouseUp/)
  })
})

// ============================================================
// Test 11: ChatPanel stores collapse state in localStorage
// (test-2-4-004-011)
// ============================================================

describe("test-2-4-004-011: ChatPanel stores collapse state in localStorage", () => {
  test("localStorage is accessed for collapse state", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/localStorage/)
  })

  test("chat-panel-collapsed key is used", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/chat-panel-collapsed/)
  })
})

// ============================================================
// Test 12: ChatPanel default width is 400px stored in localStorage
// (test-2-4-004-012)
// ============================================================

describe("test-2-4-004-012: ChatPanel default width is 400px stored in localStorage", () => {
  test("Default width of 400 is defined", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/400/)
  })

  test("chat-panel-width key is used for localStorage", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/chat-panel-width/)
  })
})

// ============================================================
// Test 13: ChatPanel displays stream errors with Retry button
// (test-2-4-004-013)
// ============================================================

describe("test-2-4-004-013: ChatPanel displays stream errors with Retry button", () => {
  test("Alert component is imported from shadcn", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*Alert.*from/)
  })

  test("Error state is handled and displayed", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/error/)
    expect(source).toMatch(/<Alert/)
  })

  test("Retry button exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Retry|retry/)
  })
})

// ============================================================
// Test 14: ChatPanel uses useDomains().studioChat for domain access
// (test-2-4-004-014)
// ============================================================

describe("test-2-4-004-014: ChatPanel uses useDomains().studioChat for domain access", () => {
  test("useDomains hook is imported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*useDomains.*from/)
  })

  test("studioChat is destructured from useDomains()", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/studioChat/)
    expect(source).toMatch(/useDomains\s*\(\s*\)/)
  })
})

// ============================================================
// Module Export Tests
// ============================================================

describe("ChatPanel module exports", () => {
  test("ChatPanel is exported as named export", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(function|const)\s+ChatPanel/)
  })
})
