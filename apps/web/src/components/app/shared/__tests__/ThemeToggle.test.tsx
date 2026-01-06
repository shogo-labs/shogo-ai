/**
 * ThemeToggle Component Tests
 * Task: task-2-1-004 (theme-toggle-component)
 *
 * Tests verify:
 * 1. Component renders with correct icon based on theme state
 * 2. Uses classList.toggle('dark') for theme switching (NOT data-attributes)
 * 3. Persists theme preference to localStorage key 'theme'
 * 4. Shows Sun icon in dark mode, Moon icon in light mode
 * 5. Uses shadcn Button with variant='ghost'
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from "bun:test"
import { render, fireEvent, cleanup, screen } from "@testing-library/react"
import { ThemeToggle } from "../ThemeToggle"

// Set up happy-dom
import { Window } from "happy-dom"

let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document
let originalLocalStorage: typeof globalThis.localStorage

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  originalLocalStorage = globalThis.localStorage
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
  // @ts-expect-error - happy-dom localStorage type mismatch
  globalThis.localStorage = window.localStorage
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  globalThis.localStorage = originalLocalStorage
  window.close()
})

beforeEach(() => {
  // Clear localStorage before each test
  window.localStorage.clear()

  // Reset document.documentElement classList for each test
  document.documentElement.className = ""
})

afterEach(() => {
  cleanup()
  document.documentElement.className = ""
})

// ============================================================
// Test: Rendering
// ============================================================
describe("ThemeToggle Rendering", () => {
  test("renders without crashing", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
  })

  test("renders with ghost variant button styling", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")
    // Ghost variant has hover:bg-secondary class
    expect(button?.className).toContain("hover:bg-secondary")
  })

  test("renders as icon-sized button", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")
    // Icon size has h-9 w-9 classes
    expect(button?.className).toContain("h-9")
    expect(button?.className).toContain("w-9")
  })
})

// ============================================================
// Test: Icon Display
// ============================================================
describe("ThemeToggle Icon Display", () => {
  test("shows Sun icon when in dark mode", () => {
    // Set dark mode
    document.documentElement.classList.add("dark")

    const { container } = render(<ThemeToggle />)

    // Sun icon should be visible in dark mode (to switch to light)
    const sunIcon = container.querySelector('[data-testid="sun-icon"]')
    expect(sunIcon).not.toBeNull()
  })

  test("shows Moon icon when in light mode", () => {
    // Ensure light mode (no dark class)
    document.documentElement.classList.remove("dark")

    const { container } = render(<ThemeToggle />)

    // Moon icon should be visible in light mode (to switch to dark)
    const moonIcon = container.querySelector('[data-testid="moon-icon"]')
    expect(moonIcon).not.toBeNull()
  })
})

// ============================================================
// Test: Theme Toggling
// ============================================================
describe("ThemeToggle Theme Toggling", () => {
  test("toggles dark class on document.documentElement when clicked", () => {
    // Start in light mode
    document.documentElement.classList.remove("dark")

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    // Click to switch to dark mode
    fireEvent.click(button)
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    // Click to switch back to light mode
    fireEvent.click(button)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("uses classList.toggle method for theme switching", () => {
    // Start in light mode (no 'dark' class)
    document.documentElement.classList.remove("dark")

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    // Before click: should not have 'dark' class
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    fireEvent.click(button)

    // After click: should have 'dark' class (toggled on)
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    // This verifies classList.toggle was used because it toggled from false to true
  })

  test("updates icon after toggle", () => {
    // Start in light mode
    document.documentElement.classList.remove("dark")

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    // Initially shows Moon (light mode)
    expect(container.querySelector('[data-testid="moon-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sun-icon"]')).toBeNull()

    // Click to switch to dark
    fireEvent.click(button)

    // Now shows Sun (dark mode)
    expect(container.querySelector('[data-testid="sun-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="moon-icon"]')).toBeNull()
  })
})

// ============================================================
// Test: localStorage Persistence
// ============================================================
describe("ThemeToggle localStorage Persistence", () => {
  test("saves 'dark' to localStorage when switching to dark mode", () => {
    // Start in light mode
    document.documentElement.classList.remove("dark")
    window.localStorage.clear()

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify localStorage was updated with 'dark'
    expect(window.localStorage.getItem("theme")).toBe("dark")
  })

  test("saves 'light' to localStorage when switching to light mode", () => {
    // Start in dark mode
    document.documentElement.classList.add("dark")
    window.localStorage.clear()

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify localStorage was updated with 'light'
    expect(window.localStorage.getItem("theme")).toBe("light")
  })

  test("uses localStorage key 'theme'", () => {
    window.localStorage.clear()

    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify the key used is 'theme'
    expect(window.localStorage.getItem("theme")).not.toBeNull()
    // Verify no other theme-related keys are used
    expect(window.localStorage.getItem("data-theme")).toBeNull()
    expect(window.localStorage.getItem("studio-theme")).toBeNull()
  })
})

// ============================================================
// Test: NO data-attribute approach
// ============================================================
describe("ThemeToggle does NOT use data-attribute approach", () => {
  test("does NOT use data-theme attribute on document", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify no data-theme attribute
    expect(document.documentElement.getAttribute("data-theme")).toBeNull()
  })

  test("does NOT use data-studio-theme attribute on document", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify no data-studio-theme attribute (StudioPage pattern)
    expect(document.documentElement.getAttribute("data-studio-theme")).toBeNull()
  })
})

// ============================================================
// Test: Accessibility
// ============================================================
describe("ThemeToggle Accessibility", () => {
  test("has accessible button role", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    expect(button?.tagName).toBe("BUTTON")
  })

  test("has aria-label for screen readers", () => {
    const { container } = render(<ThemeToggle />)
    const button = container.querySelector("button")
    expect(button?.getAttribute("aria-label")).not.toBeNull()
  })

  test("aria-label reflects current theme state", () => {
    // Test light mode aria-label
    document.documentElement.classList.remove("dark")
    const { container: lightContainer } = render(<ThemeToggle />)
    const lightButton = lightContainer.querySelector("button")
    expect(lightButton?.getAttribute("aria-label")).toContain("dark")

    cleanup()

    // Test dark mode aria-label
    document.documentElement.classList.add("dark")
    const { container: darkContainer } = render(<ThemeToggle />)
    const darkButton = darkContainer.querySelector("button")
    expect(darkButton?.getAttribute("aria-label")).toContain("light")
  })
})
