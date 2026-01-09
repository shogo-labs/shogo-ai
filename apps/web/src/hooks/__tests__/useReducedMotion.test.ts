/**
 * useReducedMotion Hook Tests
 * Task: task-chat-002
 *
 * Tests for the useReducedMotion hook that returns boolean matching
 * prefers-reduced-motion media query.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test"
import React, { createElement, useState, useEffect, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"

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
  container = document.createElement("div")
  container.id = "root"
  document.body.appendChild(container)
  root = createRoot(container)
})

// ============================================================
// Mock matchMedia for testing
// ============================================================

interface MockMediaQueryList {
  matches: boolean
  media: string
  addEventListener: ReturnType<typeof mock>
  removeEventListener: ReturnType<typeof mock>
  dispatchEvent: () => boolean
  onchange: null
  addListener: () => void
  removeListener: () => void
}

let mockMediaQueryList: MockMediaQueryList
let changeListeners: Array<(e: MediaQueryListEvent) => void> = []

function setupMatchMedia(matches: boolean = false) {
  changeListeners = []
  mockMediaQueryList = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: mock((event: string, callback: (e: MediaQueryListEvent) => void) => {
      if (event === "change") {
        changeListeners.push(callback)
      }
    }),
    removeEventListener: mock((event: string, callback: (e: MediaQueryListEvent) => void) => {
      if (event === "change") {
        const index = changeListeners.indexOf(callback)
        if (index > -1) {
          changeListeners.splice(index, 1)
        }
      }
    }),
    dispatchEvent: () => true,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
  }

  // @ts-expect-error - mock matchMedia on window
  window.matchMedia = mock((query: string) => {
    return mockMediaQueryList
  })
}

// ============================================================
// Import hook after setting up mocks
// ============================================================

// We need to import the hook dynamically or use a test component
// that captures the hook's return value

function TestComponent({ onValue }: { onValue: (val: boolean) => void }) {
  // Import dynamically to ensure window.matchMedia is mocked
  const { useReducedMotion } = require("../useReducedMotion")
  const value = useReducedMotion()

  useEffect(() => {
    onValue(value)
  }, [value, onValue])

  return createElement("div", { "data-testid": "test-value" }, String(value))
}

// ============================================================
// Tests
// ============================================================

describe("task-chat-002: useReducedMotion Hook", () => {
  test("returns boolean value matching initial media query state (false)", async () => {
    setupMatchMedia(false)

    let capturedValue: boolean | undefined

    await act(async () => {
      root.render(
        createElement(TestComponent, {
          onValue: (val) => { capturedValue = val }
        })
      )
    })

    expect(typeof capturedValue).toBe("boolean")
    expect(capturedValue).toBe(false)
  })

  test("returns true when prefers-reduced-motion matches", async () => {
    setupMatchMedia(true)

    let capturedValue: boolean | undefined

    await act(async () => {
      root.render(
        createElement(TestComponent, {
          onValue: (val) => { capturedValue = val }
        })
      )
    })

    expect(capturedValue).toBe(true)
  })

  test("sets up event listener for media query changes", async () => {
    setupMatchMedia(false)

    await act(async () => {
      root.render(
        createElement(TestComponent, {
          onValue: () => {}
        })
      )
    })

    // Check addEventListener was called
    expect(mockMediaQueryList.addEventListener).toHaveBeenCalled()
  })

  test("cleans up event listener on unmount", async () => {
    setupMatchMedia(false)

    await act(async () => {
      root.render(
        createElement(TestComponent, {
          onValue: () => {}
        })
      )
    })

    // Unmount the component
    await act(async () => {
      root.unmount()
    })

    // Check removeEventListener was called
    expect(mockMediaQueryList.removeEventListener).toHaveBeenCalled()
  })
})
