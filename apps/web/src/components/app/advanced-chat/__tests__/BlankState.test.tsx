/**
 * Tests for BlankState Component
 * Task: task-testbed-blank-state
 * TestSpecification: test-blank-state-render
 *
 * Tests the BlankState component shown when workspace has no open panels:
 * - Sparkles icon from lucide-react
 * - Heading 'How can I help you build today?' visible
 * - Subtext visible
 * - Component renders centered in workspace
 * - Optional onSuggestionClick callback
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
import React from "react"
import { BlankState } from "../BlankState"

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
// Test: BlankState renders correctly
// Given: BlankState component mounted
// When: Component renders
// Then: Sparkles icon visible, Heading visible, Subtext visible
// ============================================================
describe("BlankState renders correctly", () => {
  test("Component renders without errors", () => {
    expect(() => render(<BlankState />)).not.toThrow()
  })

  test("Sparkles icon is visible", () => {
    const { container } = render(<BlankState />)

    // Sparkles icon from lucide-react should be present
    // lucide-react icons render as SVG elements with specific data attributes or classes
    const svgElement = container.querySelector("svg")
    expect(svgElement).not.toBeNull()

    // Check for h-12 w-12 sizing classes as specified in requirements
    expect(svgElement?.classList.contains("h-12")).toBe(true)
    expect(svgElement?.classList.contains("w-12")).toBe(true)
  })

  test("Heading 'How can I help you build today?' is visible", () => {
    const { container } = render(<BlankState />)

    // Check for the heading text
    const heading = container.querySelector("h2")
    expect(heading).not.toBeNull()
    expect(heading?.textContent).toBe("How can I help you build today?")
  })

  test("Subtext is visible", () => {
    const { container } = render(<BlankState />)

    // Check for subtext paragraph
    const subtext = container.querySelector("p")
    expect(subtext).not.toBeNull()
    expect(subtext?.textContent).toBeTruthy()
    expect(subtext?.classList.contains("text-muted-foreground")).toBe(true)
  })
})

// ============================================================
// Test: BlankState renders centered in workspace
// ============================================================
describe("BlankState renders centered in workspace", () => {
  test("Contains h-full class for full height", () => {
    const { container } = render(<BlankState />)
    const rootElement = container.firstElementChild

    expect(rootElement).not.toBeNull()
    expect(rootElement?.classList.contains("h-full")).toBe(true)
  })

  test("Contains flex items-center justify-center classes for centering", () => {
    const { container } = render(<BlankState />)
    const rootElement = container.firstElementChild

    expect(rootElement).not.toBeNull()
    expect(rootElement?.classList.contains("flex")).toBe(true)
    expect(rootElement?.classList.contains("items-center")).toBe(true)
    expect(rootElement?.classList.contains("justify-center")).toBe(true)
  })

  test("Content is wrapped in a centered container with text-center", () => {
    const { container } = render(<BlankState />)

    // Inner container should have text-center for centering text content
    const innerContainer = container.querySelector(".text-center")
    expect(innerContainer).not.toBeNull()
  })
})

// ============================================================
// Test: BlankState styling follows design requirements
// ============================================================
describe("BlankState styling follows design requirements", () => {
  test("Heading has appropriate styling (text-xl font-semibold)", () => {
    const { container } = render(<BlankState />)
    const heading = container.querySelector("h2")

    expect(heading).not.toBeNull()
    expect(heading?.classList.contains("text-xl")).toBe(true)
    expect(heading?.classList.contains("font-semibold")).toBe(true)
  })

  test("Icon has text-muted-foreground color", () => {
    const { container } = render(<BlankState />)
    const svgElement = container.querySelector("svg")

    expect(svgElement).not.toBeNull()
    expect(svgElement?.classList.contains("text-muted-foreground")).toBe(true)
  })

  test("Icon is centered with mx-auto and has margin-bottom", () => {
    const { container } = render(<BlankState />)
    const svgElement = container.querySelector("svg")

    expect(svgElement).not.toBeNull()
    expect(svgElement?.classList.contains("mx-auto")).toBe(true)
    expect(svgElement?.classList.contains("mb-4")).toBe(true)
  })

  test("Content container has max-w-md for appropriate width", () => {
    const { container } = render(<BlankState />)
    const innerContainer = container.querySelector(".max-w-md")

    expect(innerContainer).not.toBeNull()
  })
})

// ============================================================
// Test: BlankState accepts optional onSuggestionClick callback
// ============================================================
describe("BlankState accepts optional onSuggestionClick callback", () => {
  test("Renders without onSuggestionClick callback", () => {
    expect(() => render(<BlankState />)).not.toThrow()
  })

  test("Accepts onSuggestionClick callback prop", () => {
    const mockCallback = mock(() => {})
    expect(() => render(<BlankState onSuggestionClick={mockCallback} />)).not.toThrow()
  })
})
