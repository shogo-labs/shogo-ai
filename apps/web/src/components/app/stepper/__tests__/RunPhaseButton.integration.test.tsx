/**
 * RunPhaseButton-ChatContext Integration Tests
 * Task: task-2-4-006
 *
 * TDD tests for wiring RunPhaseButton to ChatContext, enabling skill invocation
 * via chat message when button is clicked.
 *
 * Test Specifications:
 * - test-2-4-006-001: RunPhaseButton imports useChatContext from ChatContext
 * - test-2-4-006-002: RunPhaseButton accesses sendMessage from context when available
 * - test-2-4-006-003: RunPhaseButton formats message correctly on click
 * - test-2-4-006-004: RunPhaseButton is disabled when chat context unavailable (graceful fallback)
 * - test-2-4-006-005: RunPhaseButton is enabled when chat context available and onRun callable
 * - test-2-4-006-006: PhaseContentPanel or EmptyPhaseContent passes featureName to RunPhaseButton
 *
 * Acceptance Criteria:
 * - RunPhaseButton.tsx imports useChatContext from ChatContext
 * - RunPhaseButton accesses sendMessage from context when available
 * - RunPhaseButton onRun handler formats message: 'Execute /{phaseName} skill for feature session {sessionName}'
 * - RunPhaseButton disabled when chat context unavailable (graceful fallback)
 * - RunPhaseButton enabled when chat context available and onRun is callable
 * - PhaseContentPanel or EmptyPhaseContent passes featureName to RunPhaseButton
 * - Test verifies message format and context integration
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test"
import React, { createElement } from "react"
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
// Test 1: RunPhaseButton imports useChatContext from ChatContext
// (test-2-4-006-001)
// ============================================================

describe("test-2-4-006-001: RunPhaseButton imports useChatContext from ChatContext", () => {
  const componentPath = path.resolve(import.meta.dir, "../RunPhaseButton.tsx")

  test("RunPhaseButton.tsx file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("RunPhaseButton imports useChatContext or useChatContextSafe from ChatContext", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should import useChatContext or useChatContextSafe from ChatContext module
    expect(source).toMatch(/import.*(?:useChatContext|useChatContextSafe).*from.*["'].*ChatContext["']/)
  })

  test("useChatContext hook is called in component", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should call useChatContext or useChatContextSafe hook
    expect(source).toMatch(/(?:useChatContext|useChatContextSafe)\s*\(/)
  })
})

// ============================================================
// Test 2: RunPhaseButton accesses sendMessage from context when available
// (test-2-4-006-002)
// ============================================================

describe("test-2-4-006-002: RunPhaseButton accesses sendMessage from context when available", () => {
  test("RunPhaseButton renders without crashing when inside ChatContextProvider", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
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
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "test-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]')
    expect(button).not.toBeNull()
  })

  test("Button is enabled when context provides sendMessage", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
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
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "test-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(false)
  })
})

// ============================================================
// Test 3: RunPhaseButton formats message correctly on click
// (test-2-4-006-003)
// ============================================================

describe("test-2-4-006-003: RunPhaseButton formats message correctly on click", () => {
  test("sendMessage is called when button is clicked", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    let capturedMessage: string | null = null
    const mockSendMessage = (content: string) => {
      capturedMessage = content
    }

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "my-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    expect(button).not.toBeNull()

    await act(async () => {
      button.click()
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedMessage).not.toBeNull()
  })

  test("Message format is: Execute /{phaseName} skill for feature session {featureName}", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    let capturedMessage: string | null = null
    const mockSendMessage = (content: string) => {
      capturedMessage = content
    }

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "my-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Message format: "Execute /discovery skill for feature session my-feature"
    expect(capturedMessage).toBe("Execute /discovery skill for feature session my-feature")
  })

  test("Message uses correct phaseName from props", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    let capturedMessage: string | null = null
    const mockSendMessage = (content: string) => {
      capturedMessage = content
    }

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(RunPhaseButton, {
            phaseName: "analysis",
            featureName: "another-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedMessage).toBe("Execute /analysis skill for feature session another-feature")
  })
})

// ============================================================
// Test 4: RunPhaseButton is disabled when chat context unavailable
// (test-2-4-006-004)
// ============================================================

describe("test-2-4-006-004: RunPhaseButton is disabled when chat context unavailable", () => {
  test("RunPhaseButton renders without crashing outside ChatContextProvider", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")

    // Render without ChatContextProvider
    await act(async () => {
      root.render(
        createElement(RunPhaseButton, {
          phaseName: "discovery",
          featureName: "test-feature",
        })
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should render gracefully without error
    const button = window.document.querySelector('[data-testid="run-phase-button"]')
    expect(button).not.toBeNull()
  })

  test("Button is disabled when context unavailable (graceful fallback)", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")

    await act(async () => {
      root.render(
        createElement(RunPhaseButton, {
          phaseName: "discovery",
          featureName: "test-feature",
        })
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(true)
  })

  test("No error thrown on render when context unavailable", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")

    let errorThrown = false
    try {
      await act(async () => {
        root.render(
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "test-feature",
          })
        )
      })
    } catch {
      errorThrown = true
    }

    expect(errorThrown).toBe(false)
  })
})

// ============================================================
// Test 5: RunPhaseButton is enabled when chat context available
// (test-2-4-006-005)
// ============================================================

describe("test-2-4-006-005: RunPhaseButton is enabled when chat context available and onRun callable", () => {
  test("Button is not disabled when context is available", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
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
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "test-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  test("Click handler is active when context available", async () => {
    const { RunPhaseButton } = await import("../RunPhaseButton")
    const { ChatContextProvider } = await import("../../chat/ChatContext")

    let clicked = false
    const mockSendMessage = () => {
      clicked = true
    }

    const mockValue = {
      currentSession: { id: "session-1", name: "test-feature" },
      messages: [],
      sendMessage: mockSendMessage,
      isLoading: false,
      error: null,
    }

    await act(async () => {
      root.render(
        createElement(
          ChatContextProvider,
          { value: mockValue },
          createElement(RunPhaseButton, {
            phaseName: "discovery",
            featureName: "test-feature",
          })
        )
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const button = window.document.querySelector('[data-testid="run-phase-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    expect(clicked).toBe(true)
  })
})

// ============================================================
// Test 6: PhaseContentPanel or EmptyPhaseContent passes featureName
// (test-2-4-006-006)
// ============================================================

describe("test-2-4-006-006: PhaseContentPanel or EmptyPhaseContent passes featureName to RunPhaseButton", () => {
  test("RunPhaseButton props interface includes featureName", () => {
    const componentPath = path.resolve(import.meta.dir, "../RunPhaseButton.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")

    // RunPhaseButtonProps should include featureName
    expect(source).toMatch(/featureName\s*[?:]/)
  })

  test("EmptyPhaseContent passes featureName to RunPhaseButton", () => {
    const emptyStatesPath = path.resolve(import.meta.dir, "../EmptyStates.tsx")
    const source = fs.readFileSync(emptyStatesPath, "utf-8")

    // EmptyPhaseContent should accept featureName prop
    expect(source).toMatch(/featureName/)
  })

  test("EmptyPhaseContent interface includes featureName prop", () => {
    const emptyStatesPath = path.resolve(import.meta.dir, "../EmptyStates.tsx")
    const source = fs.readFileSync(emptyStatesPath, "utf-8")

    // EmptyPhaseContentProps should include featureName
    expect(source).toMatch(/EmptyPhaseContentProps[\s\S]*featureName/)
  })
})

// ============================================================
// Component Interface Tests
// ============================================================

describe("RunPhaseButton component interface for context integration", () => {
  test("accepts featureName prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../RunPhaseButton.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toContain("featureName")
  })

  test("exports RunPhaseButtonProps with featureName", () => {
    const componentPath = path.resolve(import.meta.dir, "../RunPhaseButton.tsx")
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export interface RunPhaseButtonProps[\s\S]*featureName/)
  })
})
