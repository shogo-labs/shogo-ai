/**
 * Tests for SplashScreen Component
 * Task: task-2-1-003
 *
 * Tests the SplashScreen component shown during auth initialization:
 * - Full-screen layout (h-screen) with centered content
 * - Displays logo or app name and loading spinner
 * - Uses Tailwind classes: h-screen, flex, items-center, justify-center
 * - Respects current theme (works in both light and dark mode)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import React from "react"
import { SplashScreen } from "../SplashScreen"

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
// Test: SplashScreen renders full-screen centered loading indicator
// ============================================================
describe("SplashScreen renders full-screen centered loading indicator", () => {
  test("Component renders without errors", () => {
    expect(() => render(<SplashScreen />)).not.toThrow()
  })

  test("Contains h-screen class for full height", () => {
    const { container } = render(<SplashScreen />)
    const rootElement = container.firstElementChild

    expect(rootElement).not.toBeNull()
    expect(rootElement?.classList.contains("h-screen")).toBe(true)
  })

  test("Contains flex items-center justify-center classes for centering", () => {
    const { container } = render(<SplashScreen />)
    const rootElement = container.firstElementChild

    expect(rootElement).not.toBeNull()
    expect(rootElement?.classList.contains("flex")).toBe(true)
    expect(rootElement?.classList.contains("items-center")).toBe(true)
    expect(rootElement?.classList.contains("justify-center")).toBe(true)
  })

  test("Displays loading spinner or indicator", () => {
    const { container } = render(<SplashScreen />)

    // Should have a spinner element (Loader2 from lucide-react has animate-spin class)
    const spinner = container.querySelector(".animate-spin")
    expect(spinner).not.toBeNull()
  })

  test("Displays app name or branding", () => {
    const { container } = render(<SplashScreen />)

    // Should display some text content (app name)
    expect(container.textContent).toBeTruthy()
  })
})

// ============================================================
// Test: SplashScreen respects current theme
// ============================================================
describe("SplashScreen respects current theme", () => {
  test("Uses theme-aware background color (bg-background)", () => {
    const { container } = render(<SplashScreen />)
    const rootElement = container.firstElementChild

    expect(rootElement).not.toBeNull()
    // bg-background is the theme-aware background class
    expect(rootElement?.classList.contains("bg-background")).toBe(true)
  })

  test("Uses theme-aware text color (text-foreground or text-muted-foreground)", () => {
    const { container } = render(<SplashScreen />)

    // Check if text uses theme-aware colors
    const hasThemeAwareText =
      container.querySelector(".text-foreground") !== null ||
      container.querySelector(".text-muted-foreground") !== null

    expect(hasThemeAwareText).toBe(true)
  })

  test("Component renders correctly with dark class on document", () => {
    // Add dark class to simulate dark mode
    globalThis.document.documentElement.classList.add("dark")

    const { container } = render(<SplashScreen />)
    const rootElement = container.firstElementChild

    // Should still render with same classes
    expect(rootElement?.classList.contains("h-screen")).toBe(true)
    expect(rootElement?.classList.contains("bg-background")).toBe(true)

    // Clean up
    globalThis.document.documentElement.classList.remove("dark")
  })
})

// ============================================================
// Test: SplashScreen uses correct component structure
// ============================================================
describe("SplashScreen component structure", () => {
  test("Has a single root container element", () => {
    const { container } = render(<SplashScreen />)

    // Should have exactly one root element
    expect(container.children.length).toBe(1)
  })

  test("Content is wrapped in a centered container", () => {
    const { container } = render(<SplashScreen />)
    const rootElement = container.firstElementChild

    // Root should be a div
    expect(rootElement?.tagName.toLowerCase()).toBe("div")
  })

  test("Spinner and text are both present", () => {
    const { container } = render(<SplashScreen />)

    // Should have spinner
    const spinner = container.querySelector(".animate-spin")
    expect(spinner).not.toBeNull()

    // Should have text content
    const textContent = container.textContent?.trim()
    expect(textContent).toBeTruthy()
    expect(textContent!.length).toBeGreaterThan(0)
  })
})
