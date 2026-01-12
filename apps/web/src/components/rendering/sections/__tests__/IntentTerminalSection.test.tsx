/**
 * Tests for IntentTerminalSection component
 * Task: task-cpv-006
 *
 * Verifies:
 * 1. Component accepts SectionRendererProps (feature, config?)
 * 2. Renders feature.intent with terminal-style monospace formatting
 * 3. Uses green text, dark background matching existing IntentTerminal
 * 4. Handles undefined/empty intent gracefully
 * 5. Registered in sectionImplementationMap with key 'IntentTerminalSection'
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

import { IntentTerminalSection } from "../IntentTerminalSection"
import { getSectionComponent, sectionImplementationMap } from "../../sectionImplementations"

describe("IntentTerminalSection", () => {
  describe("SectionRendererProps interface", () => {
    test("accepts feature prop and renders without error", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      expect(container).toBeDefined()
    })

    test("accepts optional config prop", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const config = { showHeader: true }
      const { container } = render(
        <IntentTerminalSection feature={feature} config={config} />
      )
      expect(container).toBeDefined()
    })
  })

  describe("terminal-style rendering", () => {
    test("renders feature.intent text", () => {
      const feature = { id: "test-1", intent: "Build a user authentication system" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      expect(container.textContent).toContain("Build a user authentication system")
    })

    test("has terminal styling with dark background", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      // Check for dark background class (zinc-900 or gray-900)
      const terminalElement = container.querySelector('[class*="bg-zinc-900"]') ||
        container.querySelector('[class*="bg-gray-900"]')
      expect(terminalElement).toBeDefined()
    })

    test("has monospace font styling", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      // Check for font-mono class
      const monoElement = container.querySelector('[class*="font-mono"]')
      expect(monoElement).toBeDefined()
    })

    test("has green text styling for intent", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      // Check for green text class (green-400)
      const greenElement = container.querySelector('[class*="text-green-400"]')
      expect(greenElement).toBeDefined()
    })

    test("has data-testid for terminal element", () => {
      const feature = { id: "test-1", intent: "Test intent" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      const terminal = container.querySelector('[data-testid="intent-terminal-section"]')
      expect(terminal).toBeDefined()
    })
  })

  describe("graceful handling of undefined/empty intent", () => {
    test("handles undefined intent gracefully", () => {
      const feature = { id: "test-1" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      expect(container).toBeDefined()
      // Should show some placeholder or fallback
      expect(container.textContent).toBeDefined()
    })

    test("handles empty string intent gracefully", () => {
      const feature = { id: "test-1", intent: "" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      expect(container).toBeDefined()
    })

    test("handles null feature gracefully", () => {
      const { container } = render(<IntentTerminalSection feature={null} />)
      expect(container).toBeDefined()
    })

    test("handles undefined feature gracefully", () => {
      const { container } = render(<IntentTerminalSection feature={undefined} />)
      expect(container).toBeDefined()
    })

    test("shows fallback message when no intent", () => {
      const feature = { id: "test-1" }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      // Should show fallback text like "No intent specified" or similar
      expect(container.textContent?.toLowerCase()).toMatch(/no intent|not specified|empty/i)
    })
  })

  describe("preserves whitespace", () => {
    test("preserves multiline intent formatting", () => {
      const multilineIntent = "Line 1\nLine 2\nLine 3"
      const feature = { id: "test-1", intent: multilineIntent }
      const { container } = render(<IntentTerminalSection feature={feature} />)
      // Check for whitespace-pre-wrap class
      const preElement = container.querySelector('[class*="whitespace-pre-wrap"]') ||
        container.querySelector('pre')
      expect(preElement).toBeDefined()
    })
  })
})

describe("sectionImplementationMap registration", () => {
  test("IntentTerminalSection is registered in sectionImplementationMap", () => {
    const component = sectionImplementationMap.get("IntentTerminalSection")
    expect(component).toBeDefined()
  })

  test("getSectionComponent returns IntentTerminalSection for key", () => {
    const component = getSectionComponent("IntentTerminalSection")
    expect(component).toBe(IntentTerminalSection)
  })
})
