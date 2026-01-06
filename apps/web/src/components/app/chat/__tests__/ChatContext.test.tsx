/**
 * ChatContext Tests
 * Task: task-2-4-001
 *
 * TDD tests for ChatContext foundation with provider and hook for sharing
 * chat state across components.
 *
 * Test Specifications:
 * - test-2-4-001-001: ChatContext provider renders children
 * - test-2-4-001-002: useChatContext throws when used outside provider
 * - test-2-4-001-003: useChatContext returns context value inside provider
 * - test-2-4-001-004: sendMessage function signature is (content: string) => void
 * - test-2-4-001-005: ChatContextValue interface is exported for type checking
 *
 * Acceptance Criteria:
 * - ChatContext.tsx exports ChatContextValue interface with: currentSession, messages, sendMessage, isLoading, error
 * - ChatContextProvider component accepts children and provides context value
 * - useChatContext() hook returns context value or throws Error if used outside provider
 * - sendMessage function signature is (content: string) => void
 * - Context types properly exported for consumer type checking
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
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
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

// ============================================================
// Test 1: ChatContext provider renders children
// (test-2-4-001-001)
// ============================================================

describe("test-2-4-001-001: ChatContext provider renders children", () => {
  test("ChatContext.tsx file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ChatContextProvider is exported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(function|const)\s+ChatContextProvider/)
  })

  test("ChatContextProvider accepts children prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/children/)
    expect(source).toMatch(/ReactNode/)
  })

  test("ChatContextProvider renders children within provider", async () => {
    const { ChatContextProvider } = await import("../ChatContext")

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement("div", { "data-testid": "child" }, "Test Child")
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const child = window.document.querySelector('[data-testid="child"]')
    expect(child).not.toBeNull()
    expect(child?.textContent).toBe("Test Child")
  })
})

// ============================================================
// Test 2: useChatContext throws when used outside provider
// (test-2-4-001-002)
// ============================================================

describe("test-2-4-001-002: useChatContext throws when used outside provider", () => {
  test("useChatContext is exported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+function\s+useChatContext/)
  })

  test("useChatContext throws Error when used outside provider", async () => {
    const { useChatContext } = await import("../ChatContext")

    // Create a component that uses the hook without provider
    const TestComponent: React.FC = () => {
      try {
        useChatContext()
        return createElement("div", null, "No error")
      } catch (error) {
        return createElement("div", { "data-testid": "error" }, (error as Error).message)
      }
    }

    await act(async () => {
      root.render(createElement(TestComponent))
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const errorDiv = window.document.querySelector('[data-testid="error"]')
    expect(errorDiv).not.toBeNull()
  })

  test("Error message mentions ChatContextProvider", async () => {
    const { useChatContext } = await import("../ChatContext")

    const TestComponent: React.FC = () => {
      try {
        useChatContext()
        return createElement("div", null, "No error")
      } catch (error) {
        return createElement("div", { "data-testid": "error" }, (error as Error).message)
      }
    }

    await act(async () => {
      root.render(createElement(TestComponent))
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const errorDiv = window.document.querySelector('[data-testid="error"]')
    expect(errorDiv?.textContent).toMatch(/ChatContextProvider/i)
  })
})

// ============================================================
// Test 3: useChatContext returns context value inside provider
// (test-2-4-001-003)
// ============================================================

describe("test-2-4-001-003: useChatContext returns context value inside provider", () => {
  test("useChatContext returns ChatContextValue object", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return createElement("div", null, "Success")
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toBeDefined()
  })

  test("Context value contains currentSession property", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: { id: "session-1", name: "Test Session" },
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult!.currentSession).toEqual({ id: "session-1", name: "Test Session" })
  })

  test("Context value contains messages array", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [{ id: "msg-1", content: "Hello" }],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(Array.isArray(hookResult!.messages)).toBe(true)
    expect(hookResult!.messages).toHaveLength(1)
  })

  test("Context value contains sendMessage function", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(typeof hookResult!.sendMessage).toBe("function")
  })

  test("Context value contains isLoading boolean", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: true,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(typeof hookResult!.isLoading).toBe("boolean")
    expect(hookResult!.isLoading).toBe(true)
  })

  test("Context value contains error property", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: "Something went wrong",
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult!.error).toBe("Something went wrong")
  })
})

// ============================================================
// Test 4: sendMessage function signature is (content: string) => void
// (test-2-4-001-004)
// ============================================================

describe("test-2-4-001-004: sendMessage function signature", () => {
  test("sendMessage function is callable", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null
    let capturedContent: string | null = null

    const mockSendMessage = (content: string) => {
      capturedContent = content
    }

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    hookResult!.sendMessage("Hello, world!")
    expect(capturedContent).toBe("Hello, world!")
  })

  test("sendMessage accepts string parameter", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null
    const messages: string[] = []

    const mockSendMessage = (content: string) => {
      messages.push(content)
    }

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    hookResult!.sendMessage("Test message")
    expect(messages).toContain("Test message")
  })

  test("sendMessage returns void", async () => {
    const { useChatContext, ChatContextProvider } = await import("../ChatContext")

    let hookResult: ReturnType<typeof useChatContext> | null = null

    const mockValue = {
      currentSession: null,
      messages: [],
      sendMessage: () => {},
      isLoading: false,
      error: null,
    }

    const TestComponent: React.FC = () => {
      hookResult = useChatContext()
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(TestComponent)
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const returnValue = hookResult!.sendMessage("Test")
    expect(returnValue).toBeUndefined()
  })
})

// ============================================================
// Test 5: ChatContextValue interface is exported for type checking
// (test-2-4-001-005)
// ============================================================

describe("test-2-4-001-005: ChatContextValue interface is exported", () => {
  test("ChatContextValue type is exported", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // Should export ChatContextValue interface
    expect(source).toMatch(/export\s+(interface|type)\s+ChatContextValue/)
  })

  test("ChatContextValue includes currentSession property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    expect(source).toMatch(/currentSession/)
  })

  test("ChatContextValue includes messages property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    expect(source).toMatch(/messages/)
  })

  test("ChatContextValue includes sendMessage property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    expect(source).toMatch(/sendMessage/)
  })

  test("ChatContextValue includes isLoading property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    expect(source).toMatch(/isLoading/)
  })

  test("ChatContextValue includes error property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ChatContext.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    expect(source).toMatch(/error/)
  })

  test("ChatContextValue can be imported as a type", async () => {
    // Verify the type can be imported
    const module = await import("../ChatContext")
    // The type should exist (TypeScript would fail compilation if not exported)
    expect(module).toBeDefined()
  })
})

// ============================================================
// Module Import Tests
// ============================================================

describe("ChatContext module exports", () => {
  test("ChatContextProvider can be imported", async () => {
    const module = await import("../ChatContext")
    expect(module.ChatContextProvider).toBeDefined()
    expect(typeof module.ChatContextProvider).toBe("function")
  })

  test("useChatContext can be imported", async () => {
    const module = await import("../ChatContext")
    expect(module.useChatContext).toBeDefined()
    expect(typeof module.useChatContext).toBe("function")
  })
})
