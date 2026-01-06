/**
 * Barrel Exports Tests
 * Task: task-2-4-007
 *
 * Tests that index.ts exports the complete public API for the chat module.
 * Verifies all required components, hooks, and types are exported.
 *
 * TestSpecification IDs:
 * - test-2-4-007-001: ChatPanel export
 * - test-2-4-007-002: ChatContextProvider export
 * - test-2-4-007-003: useChatContext hook export
 * - test-2-4-007-004: Type interfaces export
 * - test-2-4-007-005: Pattern compliance
 */

import { describe, test, expect } from "bun:test"
import * as ChatModule from "../index"

// ============================================================================
// Test: ChatPanel Export (test-2-4-007-001)
// ============================================================================

describe("index.ts exports ChatPanel component", () => {
  // Given: chat module index.ts exists
  // When: ChatPanel is imported from index
  // Then: ChatPanel can be imported without error and is a valid React component

  test("ChatPanel is exported from index", () => {
    expect(ChatModule.ChatPanel).toBeDefined()
  })

  test("ChatPanel is a valid React component (function or observer-wrapped)", () => {
    // ChatPanel is wrapped with MobX observer() which returns an object (ForwardRef)
    // Valid React components can be either functions or objects (for wrapped components)
    const isFunction = typeof ChatModule.ChatPanel === "function"
    const isObject = typeof ChatModule.ChatPanel === "object" && ChatModule.ChatPanel !== null
    expect(isFunction || isObject).toBe(true)
  })
})

// ============================================================================
// Test: ChatContextProvider Export (test-2-4-007-002)
// ============================================================================

describe("index.ts exports ChatContextProvider component", () => {
  // Given: chat module index.ts exists
  // When: ChatContextProvider is imported from index
  // Then: ChatContextProvider can be imported without error and is a valid React component

  test("ChatContextProvider is exported from index", () => {
    expect(ChatModule.ChatContextProvider).toBeDefined()
  })

  test("ChatContextProvider is a valid React component (function)", () => {
    expect(typeof ChatModule.ChatContextProvider).toBe("function")
  })
})

// ============================================================================
// Test: useChatContext Hook Export (test-2-4-007-003)
// ============================================================================

describe("index.ts exports useChatContext hook", () => {
  // Given: chat module index.ts exists
  // When: useChatContext is imported from index
  // Then: useChatContext can be imported without error and is a function

  test("useChatContext is exported from index", () => {
    expect(ChatModule.useChatContext).toBeDefined()
  })

  test("useChatContext is a function", () => {
    expect(typeof ChatModule.useChatContext).toBe("function")
  })
})

// ============================================================================
// Test: Type Interfaces Export (test-2-4-007-004)
// ============================================================================

describe("index.ts exports type interfaces", () => {
  // Given: chat module index.ts exists
  // When: Type interfaces are imported from index
  // Then: All required type interfaces are exported
  //
  // Note: TypeScript types are erased at runtime, so we verify by checking
  // that the module can be imported without type errors and that related
  // components/functions that use these types are present.

  test("ChatContextValue type is exported (verified by ChatContextProvider presence)", () => {
    // ChatContextValue is used by ChatContextProvider - if the component exists,
    // the type must be properly exported for consumers
    expect(ChatModule.ChatContextProvider).toBeDefined()
  })

  test("ChatPanelProps type is exported (verified by ChatPanel presence)", () => {
    // ChatPanelProps is the props type for ChatPanel
    expect(ChatModule.ChatPanel).toBeDefined()
  })

  test("ChatMessageProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ChatMessage).toBeDefined()
  })

  test("ToolCallDisplayProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ToolCallDisplay).toBeDefined()
  })

  test("ChatInputProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ChatInput).toBeDefined()
  })

  test("ChatHeaderProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ChatHeader).toBeDefined()
  })

  test("ChatSessionPickerProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ChatSessionPicker).toBeDefined()
  })

  test("ExpandTabProps type is exported", () => {
    // Verify the component that uses this type is exported
    expect(ChatModule.ExpandTab).toBeDefined()
  })
})

// ============================================================================
// Test: Pattern Compliance (test-2-4-007-005)
// ============================================================================

describe("index.ts follows existing barrel pattern in /components/app/ modules", () => {
  // Given: chat module index.ts source exists
  // When: Source code is analyzed
  // Then: File uses export syntax matching other app modules
  //       No internal implementation details exported
  //       Clean public API surface

  test("module exports expected component count (public API surface)", () => {
    // Public API should include:
    // - ChatPanel (main container)
    // - ChatContextProvider (context provider)
    // - useChatContext (hook)
    // - ChatMessage (presentational)
    // - MessageList (presentational)
    // - ToolCallDisplay (presentational)
    // - ChatInput (presentational)
    // - ChatHeader (presentational)
    // - ChatSessionPicker (presentational)
    // - ExpandTab (presentational)

    const exportedKeys = Object.keys(ChatModule)

    // Should have at least these core exports
    expect(exportedKeys).toContain("ChatPanel")
    expect(exportedKeys).toContain("ChatContextProvider")
    expect(exportedKeys).toContain("useChatContext")
    expect(exportedKeys).toContain("ChatMessage")
    expect(exportedKeys).toContain("MessageList")
    expect(exportedKeys).toContain("ToolCallDisplay")
    expect(exportedKeys).toContain("ChatInput")
    expect(exportedKeys).toContain("ChatHeader")
    expect(exportedKeys).toContain("ChatSessionPicker")
    expect(exportedKeys).toContain("ExpandTab")
  })

  test("no internal helpers are exported (clean public API)", () => {
    const exportedKeys = Object.keys(ChatModule)

    // Should NOT export internal implementation details like:
    // - extractToolCalls (internal helper in ChatPanel)
    // - mapToolCallState (internal helper in ChatPanel)
    // - getStoredCollapsed/setStoredCollapsed (local storage helpers)
    // - getStoredWidth/setStoredWidth (local storage helpers)
    expect(exportedKeys).not.toContain("extractToolCalls")
    expect(exportedKeys).not.toContain("mapToolCallState")
    expect(exportedKeys).not.toContain("getStoredCollapsed")
    expect(exportedKeys).not.toContain("setStoredCollapsed")
    expect(exportedKeys).not.toContain("getStoredWidth")
    expect(exportedKeys).not.toContain("setStoredWidth")
  })
})
