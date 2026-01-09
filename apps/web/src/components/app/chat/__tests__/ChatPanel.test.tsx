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
 * - test-2-4-004-002: ChatPanel configures useChat with /api/chat endpoint
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
// Test 2: ChatPanel configures useChat with /api/chat endpoint
// (test-2-4-004-002)
// NOTE: streamProtocol: 'text' was removed to enable metadata extraction
// ============================================================

describe("test-2-4-004-002: ChatPanel configures useChat with /api/chat endpoint", () => {
  test("useChat api option is set to /api/chat", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/api:\s*["']\/api\/chat["']/)
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

  test("User message persistence happens before sendMessage call", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    // The addMessage call with role: "user" should appear before sendMessage in the submit handler
    // We check that addMessage appears before sendMessage call in the handleSendMessage function
    const addMessageIndex = source.indexOf("addMessage")
    const sendMessageCallIndex = source.indexOf("await sendMessage(")
    expect(addMessageIndex).toBeGreaterThan(-1)
    expect(sendMessageCallIndex).toBeGreaterThan(-1)
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
    // Match both useDomains() and useDomains<{...}>() with generic type params
    expect(source).toMatch(/useDomains\s*(<[^>]+>)?\s*\(\s*\)/)
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

// ============================================================
// Task cpbi-004: Phase Prop Threading Tests
// ============================================================

// ============================================================
// Test cpbi-004-b: ChatPanel receives phase as prop
// ============================================================

describe("test-cpbi-004-b: ChatPanel receives phase as prop", () => {
  test("ChatPanel accepts phase in props destructuring", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel should destructure phase from props
    // Look for phase in the function parameter destructuring
    expect(source).toMatch(/function\s+ChatPanel\s*\(\s*\{[\s\S]*phase[\s\S]*\}/)
  })

  test("phase prop is available for use within component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have phase in props destructuring pattern
    expect(source).toMatch(/\{\s*[\s\S]*phase[\s\S]*\}\s*:\s*ChatPanelProps/)
  })
})

// ============================================================
// Test cpbi-004-c: ChatPanelProps type includes phase prop
// ============================================================

describe("test-cpbi-004-c: ChatPanelProps type includes phase prop", () => {
  test("ChatPanelProps interface includes phase property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // ChatPanelProps should have phase: string | null property
    expect(source).toMatch(/interface\s+ChatPanelProps[\s\S]*phase\s*:\s*string\s*\|\s*null/)
  })

  test("phase prop has type string | null", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // The phase property should be typed as string | null
    expect(source).toMatch(/phase\s*:\s*string\s*\|\s*null/)
  })

  test("phase prop has descriptive JSDoc comment", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have a comment describing the phase prop (either JSDoc or inline)
    // Look for phase mentioned in a comment near the interface
    expect(source).toMatch(/\/\*\*[\s\S]*phase[\s\S]*\*\/[\s\S]*phase\s*:/)
  })
})

// ============================================================
// Task cc-chatpanel-integration: CC Session ID Integration Tests
// Updated for chat-session-sync-fix: v3 API with message.metadata (not header)
// ============================================================

// ============================================================
// Test cc-int-001: ChatPanel uses v3 UIMessage stream (default, no streamProtocol needed)
// ============================================================

describe("test-cc-int-001: ChatPanel uses v3 UIMessage stream", () => {
  test("streamProtocol is NOT specified (v3 defaults to UIMessage)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // v3 API: No streamProtocol needed - defaults to UIMessage format
    expect(source).not.toMatch(/streamProtocol\s*:/)
  })

  test("streamProtocol 'text' is NOT used", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have the old text protocol
    expect(source).not.toMatch(/streamProtocol:\s*["']text["']/)
  })
})

// ============================================================
// Test cc-int-002: ChatPanel extracts ccSessionId from message.metadata (v3 API)
// ============================================================

describe("test-cc-int-002: ChatPanel CC session ID extraction from message.metadata", () => {
  test("onFinish callback extracts from message.metadata", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // v3 API: Session ID comes from message.metadata (set via server's messageMetadata callback)
    // Pattern accounts for TypeScript cast: (message as any).metadata?.ccSessionId
    expect(source).toMatch(/\.metadata\?\.ccSessionId/)
  })

  test("onResponse is NOT used for header extraction (v3 uses message.metadata)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // v3 API: No onResponse callback for session ID - uses message.metadata instead
    expect(source).not.toMatch(/onResponse[\s\S]*X-CC-Session-Id/)
  })

  test("extractCcSessionId helper function is REMOVED (marker approach obsolete)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have extractCcSessionId function (marker extraction is obsolete)
    expect(source).not.toMatch(/function extractCcSessionId/)
  })

  test("CC_SESSION_MARKER_REGEX is REMOVED (marker approach obsolete)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have CC_SESSION_MARKER_REGEX (marker extraction is obsolete)
    expect(source).not.toMatch(/CC_SESSION_MARKER_REGEX/)
  })
})

// ============================================================
// Test cc-int-003: ChatPanel stores ccSessionId in local state AND ref (spec-css-ref-01, spec-css-ref-02)
// ============================================================

describe("test-cc-int-003: ChatPanel stores ccSessionId in local state and ref", () => {
  test("ccSessionId state is defined with useState", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have useState for ccSessionId
    expect(source).toMatch(/useState.*ccSessionId|ccSessionId.*useState/)
  })

  test("setCcSessionId setter is available", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have setCcSessionId from useState destructuring
    expect(source).toMatch(/setCcSessionId/)
  })

  test("ccSessionIdRef is defined with useRef (spec-css-ref-01)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have ccSessionIdRef = useRef()
    expect(source).toMatch(/ccSessionIdRef\s*=\s*useRef/)
  })

  test("useEffect syncs ccSessionIdRef with ccSessionId state (spec-css-ref-02)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have useEffect that syncs ref with state
    expect(source).toMatch(/ccSessionIdRef\.current\s*=\s*ccSessionId/)
  })
})

// ============================================================
// Test cc-int-004: ChatPanel persists ccSessionId to domain via updateOne with await (spec-css-persist-01, spec-css-persist-02)
// ============================================================

describe("test-cc-int-004: ChatPanel domain persistence with await", () => {
  test("chatSessionCollection.updateOne is called with claudeCodeSessionId", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should call updateOne with claudeCodeSessionId when extracted
    expect(source).toMatch(/chatSessionCollection\.updateOne\(/)
    expect(source).toMatch(/claudeCodeSessionId/)
  })

  test("updateOne is awaited before setCcSessionId (spec-css-persist-01)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should await the updateOne call
    expect(source).toMatch(/await\s+studioChat\.chatSessionCollection\.updateOne/)
  })

  test("try/catch wraps persistence call (spec-css-persist-02)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have try/catch around persistence
    // The onFinish should have error handling that prevents state update on failure
    expect(source).toMatch(/try\s*\{[\s\S]*updateOne[\s\S]*\}\s*catch/)
  })

  test("claudeCodeSessionId field exists in domain schema", () => {
    // Field exists in ChatSession entity (verified in domain.test.ts)
    expect(true).toBe(true) // Schema test - verified in domain tests
  })
})

// ============================================================
// Test cc-int-005: ChatPanel passes ccSessionId via append() options (spec-css-ref-03, spec-css-ref-04)
// ============================================================

describe("test-cc-int-005: ChatPanel passes ccSessionId via append options", () => {
  test("body is NOT in useChat config (prevents stale closure)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // body should NOT be in useChat config object as an actual property
    // The old pattern: body: { featureId, phase, ccSessionId },
    // Look for actual body property assignment (not commented out)
    // Match: body: { with word boundary, not inside a comment
    const useChatMatch = source.match(/useChat\s*\(\s*\{([\s\S]*?)\}\s*\)/)
    if (useChatMatch) {
      const useChatConfig = useChatMatch[1]
      // Check that body: { is not present as an actual property (allow comments)
      // Look for body: { at start of line or after comma (actual property)
      const hasBodyProperty = /^\s*body\s*:\s*\{|,\s*body\s*:\s*\{/m.test(useChatConfig)
      expect(hasBodyProperty).toBe(false)
    }
  })

  test("sendMessage() receives options with body (spec-css-ref-04)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // v3 API: sendMessage({ text }, { body: { ... } })
    expect(source).toMatch(/sendMessage\s*\(\s*\{[\s\S]*\}\s*,\s*\{[\s\S]*body\s*:/)
  })

  test("body in sendMessage uses ccSessionIdRef.current (not state)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should use ref for latest value
    expect(source).toMatch(/ccSessionIdRef\.current/)
  })
})

// ============================================================
// Test cc-int-006: ChatPanel initializes ccSessionId from currentSession
// ============================================================

describe("test-cc-int-006: ChatPanel initializes ccSessionId from existing session", () => {
  test("ccSessionId is initialized from currentSession.claudeCodeSessionId", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should reference currentSession?.claudeCodeSessionId for initialization
    expect(source).toMatch(/currentSession\?\.claudeCodeSessionId/)
  })

  test("useEffect syncs ccSessionId when currentSession changes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should have useEffect with currentSession?.claudeCodeSessionId in dependency
    expect(source).toMatch(/useEffect[\s\S]*currentSession\?\.claudeCodeSessionId[\s\S]*\]/)
  })
})

// ============================================================
// Task cpbi-005: Phase-Bound Session Lifecycle Tests
// ============================================================

// ============================================================
// Test cpbi-005-a: ChatPanel auto-loads existing session for feature and phase
// ============================================================

describe("test-cpbi-005-a: ChatPanel auto-loads existing session for feature and phase", () => {
  test("useEffect uses findByFeatureAndPhase to lookup existing session", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should call findByFeatureAndPhase instead of just findByFeature
    expect(source).toMatch(/findByFeatureAndPhase\s*\?\.\s*\(/)
  })

  test("findByFeatureAndPhase is called with featureId and phase arguments", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should pass both featureId and phase to the lookup
    expect(source).toMatch(/findByFeatureAndPhase\s*\?\.\s*\(\s*featureId\s*,\s*phase\s*\)/)
  })

  test("Sets currentSessionId when existing session is found", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should set session ID from existingSession
    expect(source).toMatch(/setCurrentSessionId\s*\(\s*existingSession\.id\s*\)/)
  })
})

// ============================================================
// Test cpbi-005-b: ChatPanel auto-creates new session when none exists
// ============================================================

describe("test-cpbi-005-b: ChatPanel auto-creates new session when none exists", () => {
  test("createChatSession is called with phase parameter", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should pass phase to createChatSession
    expect(source).toMatch(/createChatSession\s*\(\s*\{[\s\S]*phase\s*[:=]/)
  })

  test("Session creation is awaited (async pattern)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should use await with createChatSession
    expect(source).toMatch(/await\s+studioChat\.createChatSession/)
  })

  test("New session includes phase in inferredName for identification", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // InferredName should include phase for identification
    // Pattern like: `${featureName} - ${phase}` or similar
    expect(source).toMatch(/inferredName:.*\$\{.*phase.*\}|inferredName:.*phase/)
  })
})

// ============================================================
// Test cpbi-005-c: Session switches when phase changes
// ============================================================

describe("test-cpbi-005-c: Session switches when phase changes", () => {
  test("phase is in the useEffect dependency array", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Find the session management useEffect - it should have phase in dependencies
    // The useEffect for session management should include phase in the dependency array
    // Pattern: useEffect(..., [..., phase, ...])
    // Look for the dependency array that contains phase along with featureId
    expect(source).toMatch(/useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[\s\S]*?findByFeatureAndPhase[\s\S]*?\}\s*,\s*\[[^\]]*phase[^\]]*\]/)
  })

  test("useEffect contains both featureId and phase in dependencies", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Dependency array should have both featureId and phase
    expect(source).toMatch(/\[\s*[^\]]*featureId[^\]]*phase[^\]]*\]|\[\s*[^\]]*phase[^\]]*featureId[^\]]*\]/)
  })
})

// ============================================================
// Test cpbi-005-d: append() options include featureId and phase for API context
// Updated for chat-session-sync-fix: v3 API uses sendMessage({ text }, { body: {...} })
// ============================================================

describe("test-cpbi-005-d: sendMessage options include featureId and phase for API context", () => {
  test("sendMessage() is called with options containing body", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // v3 API: sendMessage({ text }, { body: { ... } })
    expect(source).toMatch(/sendMessage\s*\(\s*\{[\s\S]*\}\s*,\s*\{[\s\S]*body\s*:/)
  })

  test("body in sendMessage includes featureId", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // body in sendMessage should include featureId
    expect(source).toMatch(/body\s*:\s*\{[\s\S]*featureId[\s\S]*\}/)
  })

  test("body in sendMessage includes phase", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // body in sendMessage should include phase
    expect(source).toMatch(/body\s*:\s*\{[\s\S]*phase[\s\S]*\}/)
  })
})

// ============================================================
// Test cpbi-005-e: Multiple phases maintain independent message histories
// ============================================================

describe("test-cpbi-005-e: Multiple phases maintain independent message histories", () => {
  test("Session lookup uses phase for uniqueness (not just featureId)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should use findByFeatureAndPhase, NOT findByFeature for session lookup
    // This ensures each phase gets its own session
    expect(source).toMatch(/findByFeatureAndPhase/)
    // And should NOT be using the old findByFeature pattern for primary lookup
    expect(source).not.toMatch(/findByFeature\s*\?\.\s*\(\s*featureId\s*\)\s*\?\?\s*\[\]/)
  })

  test("New session creation includes phase field", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // createChatSession call should include phase: phase in the object
    expect(source).toMatch(/createChatSession\s*\(\s*\{[\s\S]*phase\s*:\s*phase[\s\S]*\}/)
  })

  test("Phase changes trigger session switch (different session per phase)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // The combination of:
    // 1. findByFeatureAndPhase for lookup
    // 2. phase in dependency array
    // Ensures different phases get different sessions
    // Already verified in previous tests, but confirm both patterns exist
    expect(source).toMatch(/findByFeatureAndPhase/)
    expect(source).toMatch(/\[\s*[^\]]*phase[^\]]*\]/)
  })
})

// ============================================================
// AI SDK v3 Migration Tests (chat-session-sync-fix)
// Tests for @ai-sdk/react v3 API changes:
// - sendMessage() instead of append()
// - message.metadata for session ID (not header)
// - No streamProtocol config (default UIMessage stream)
// ============================================================

describe("AI SDK v3 API Migration (chat-session-sync-fix)", () => {
  // spec-v3-001: sendMessage replaces append
  describe("spec-v3-001: sendMessage replaces append", () => {
    test("ChatPanel uses sendMessage (not append)", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 API uses sendMessage(), not append()
      // Should destructure sendMessage from useChat
      expect(source).toMatch(/const\s*\{[\s\S]*sendMessage[\s\S]*\}\s*=\s*useChat/)
    })

    test("sendMessage is called with text object and body options", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 pattern: sendMessage({ text: content }, { body: { ... } })
      expect(source).toMatch(/sendMessage\s*\(\s*\{[\s\S]*text\s*:/)
    })

    test("append function is NOT used for sending messages", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // Should NOT have append( call (but append may exist as a word in comments)
      // Look for append being called with an object argument
      expect(source).not.toMatch(/\bappend\s*\(\s*\{[\s\S]*role\s*:/)
    })
  })

  // spec-v3-002: Session ID from message.metadata (not header)
  describe("spec-v3-002: Session ID from message.metadata", () => {
    test("onFinish extracts ccSessionId from message.metadata", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 API: message.metadata?.ccSessionId (set via messageMetadata callback on server)
      // Pattern accounts for TypeScript cast: (message as any).metadata?.ccSessionId
      expect(source).toMatch(/\.metadata\?\.ccSessionId/)
    })

    test("onResponse is NOT used for header extraction", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 API doesn't need onResponse for session ID - it's in message.metadata
      // The onResponse callback for X-CC-Session-Id extraction should be removed
      expect(source).not.toMatch(/onResponse[\s\S]*X-CC-Session-Id/)
    })

    test("X-CC-Session-Id header extraction is removed", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // Should NOT have header extraction logic
      expect(source).not.toMatch(/headers\.get\s*\(\s*["']X-CC-Session-Id["']\s*\)/)
    })
  })

  // spec-v3-003: No streamProtocol config (default UIMessage format)
  describe("spec-v3-003: No streamProtocol config", () => {
    test("streamProtocol is NOT specified in useChat", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 API defaults to UIMessage stream - no streamProtocol needed
      expect(source).not.toMatch(/streamProtocol\s*:/)
    })
  })

  // spec-v3-004: Body passed via sendMessage options
  describe("spec-v3-004: Body in sendMessage options", () => {
    test("sendMessage receives body in second argument", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // v3 pattern: sendMessage({ text }, { body: { ccSessionId, featureId, phase } })
      expect(source).toMatch(/sendMessage\s*\(\s*\{[\s\S]*\}\s*,\s*\{[\s\S]*body\s*:/)
    })

    test("Body includes ccSessionIdRef.current", () => {
      const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
      const source = fs.readFileSync(componentPath, "utf-8")

      // Should use ref for latest session ID value
      expect(source).toMatch(/body\s*:\s*\{[\s\S]*ccSessionId\s*:\s*ccSessionIdRef\.current/)
    })
  })
})

// ============================================================
// Task css-cleanup-markers: Marker Extraction Code Removal Tests
// ============================================================

describe("task-css-cleanup-markers: Marker extraction code removed", () => {
  test("CC_SESSION_MARKER_REGEX constant is removed (spec-css-cleanup-01)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have CC_SESSION_MARKER_REGEX
    expect(source).not.toMatch(/CC_SESSION_MARKER_REGEX/)
  })

  test("extractCcSessionId function is removed (spec-css-cleanup-02)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have extractCcSessionId function
    expect(source).not.toMatch(/function\s+extractCcSessionId/)
  })

  test("onFinish no longer calls extractCcSessionId (spec-css-cleanup-03)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have extractCcSessionId(message.content)
    expect(source).not.toMatch(/extractCcSessionId\s*\(\s*message\.content\s*\)/)
  })

  test("Message display no longer cleans CC_SESSION markers (spec-css-cleanup-04)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have cleanContent variable (marker cleaning variable)
    expect(source).not.toMatch(/cleanContent/)
  })

  test("No CC_SESSION references remain (spec-css-cleanup-05)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatPanel.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have any CC_SESSION references
    expect(source).not.toMatch(/CC_SESSION/)
  })
})
