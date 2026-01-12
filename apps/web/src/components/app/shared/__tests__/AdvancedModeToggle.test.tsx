/**
 * AdvancedModeToggle Component Tests
 * Task: task-testbed-mode-toggle
 *
 * Tests verify:
 * 1. Toggle renders in header with correct icon based on current route
 * 2. Clicking navigates to correct route (/app or /app/advanced-chat)
 * 3. URL params (org, project) are preserved on navigation
 * 4. Preference is persisted to localStorage key 'advanced-chat-preferred'
 * 5. Uses shadcn Button with variant='ghost' size='icon'
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
import { render, fireEvent, cleanup } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { AdvancedModeToggle } from "../AdvancedModeToggle"

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
})

afterEach(() => {
  cleanup()
})

// Helper component to capture current location for verification
function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location-display">{location.pathname}{location.search}</div>
}

// Helper to render with router
function renderWithRouter(initialPath: string = "/app") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<><AdvancedModeToggle /><LocationDisplay /></>} />
        <Route path="/app/advanced-chat" element={<><AdvancedModeToggle /><LocationDisplay /></>} />
      </Routes>
    </MemoryRouter>
  )
}

// ============================================================
// Test: Rendering (test-toggle-render)
// ============================================================
describe("AdvancedModeToggle Rendering", () => {
  test("renders without crashing", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
  })

  test("renders with ghost variant button styling", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")
    // Ghost variant has hover:bg-secondary class
    expect(button?.className).toContain("hover:bg-secondary")
  })

  test("renders as icon-sized button", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")
    // Icon size has h-9 w-9 classes
    expect(button?.className).toContain("h-9")
    expect(button?.className).toContain("w-9")
  })

  test("shows LayoutGrid icon when on standard /app route", () => {
    const { container } = renderWithRouter("/app")
    const layoutGridIcon = container.querySelector('[data-testid="layout-grid-icon"]')
    expect(layoutGridIcon).not.toBeNull()
  })

  test("shows Sparkles icon when on /app/advanced-chat route", () => {
    const { container } = renderWithRouter("/app/advanced-chat")
    const sparklesIcon = container.querySelector('[data-testid="sparkles-icon"]')
    expect(sparklesIcon).not.toBeNull()
  })
})

// ============================================================
// Test: Navigate to Advanced Chat (test-toggle-navigate-to-advanced)
// ============================================================
describe("AdvancedModeToggle Navigate to Advanced", () => {
  test("navigates from /app to /app/advanced-chat when clicked", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")!

    // Initially on /app
    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app")

    fireEvent.click(button)

    // Now on /app/advanced-chat
    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app/advanced-chat")
  })

  test("shows Sparkles icon after navigating to advanced mode", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")!

    // Initially shows LayoutGrid
    expect(container.querySelector('[data-testid="layout-grid-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sparkles-icon"]')).toBeNull()

    fireEvent.click(button)

    // Now shows Sparkles
    expect(container.querySelector('[data-testid="sparkles-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="layout-grid-icon"]')).toBeNull()
  })

  test("preserves org param when navigating to advanced", () => {
    const { container } = renderWithRouter("/app?org=shogo")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app/advanced-chat?org=shogo")
  })

  test("preserves project param when navigating to advanced", () => {
    const { container } = renderWithRouter("/app?project=abc123")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app/advanced-chat?project=abc123")
  })

  test("preserves org and project params when navigating to advanced", () => {
    const { container } = renderWithRouter("/app?org=shogo&project=abc123")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app/advanced-chat?org=shogo&project=abc123")
  })
})

// ============================================================
// Test: Navigate back to Standard (test-toggle-navigate-to-standard)
// ============================================================
describe("AdvancedModeToggle Navigate to Standard", () => {
  test("navigates from /app/advanced-chat to /app when clicked", () => {
    const { container } = renderWithRouter("/app/advanced-chat")
    const button = container.querySelector("button")!

    // Initially on /app/advanced-chat
    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app/advanced-chat")

    fireEvent.click(button)

    // Now on /app
    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app")
  })

  test("shows LayoutGrid icon after navigating to standard mode", () => {
    const { container } = renderWithRouter("/app/advanced-chat")
    const button = container.querySelector("button")!

    // Initially shows Sparkles
    expect(container.querySelector('[data-testid="sparkles-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="layout-grid-icon"]')).toBeNull()

    fireEvent.click(button)

    // Now shows LayoutGrid
    expect(container.querySelector('[data-testid="layout-grid-icon"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sparkles-icon"]')).toBeNull()
  })

  test("preserves org param when navigating to standard", () => {
    const { container } = renderWithRouter("/app/advanced-chat?org=shogo")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app?org=shogo")
  })

  test("preserves project param when navigating to standard", () => {
    const { container } = renderWithRouter("/app/advanced-chat?project=abc123")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(container.querySelector('[data-testid="location-display"]')?.textContent).toBe("/app?project=abc123")
  })
})

// ============================================================
// Test: localStorage Persistence (test-toggle-persistence)
// ============================================================
describe("AdvancedModeToggle localStorage Persistence", () => {
  test("saves 'true' to localStorage when switching to advanced mode", () => {
    window.localStorage.clear()

    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(window.localStorage.getItem("advanced-chat-preferred")).toBe("true")
  })

  test("saves 'false' to localStorage when switching to standard mode", () => {
    window.localStorage.clear()

    const { container } = renderWithRouter("/app/advanced-chat")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    expect(window.localStorage.getItem("advanced-chat-preferred")).toBe("false")
  })

  test("uses localStorage key 'advanced-chat-preferred'", () => {
    window.localStorage.clear()

    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")!

    fireEvent.click(button)

    // Verify the key used is 'advanced-chat-preferred'
    expect(window.localStorage.getItem("advanced-chat-preferred")).not.toBeNull()
  })
})

// ============================================================
// Test: Accessibility
// ============================================================
describe("AdvancedModeToggle Accessibility", () => {
  test("has accessible button role", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    expect(button?.tagName).toBe("BUTTON")
  })

  test("has aria-label for screen readers", () => {
    const { container } = renderWithRouter("/app")
    const button = container.querySelector("button")
    expect(button?.getAttribute("aria-label")).not.toBeNull()
  })

  test("aria-label reflects current mode state", () => {
    // Test standard mode aria-label
    const { container: standardContainer } = renderWithRouter("/app")
    const standardButton = standardContainer.querySelector("button")
    expect(standardButton?.getAttribute("aria-label")).toContain("advanced")

    cleanup()

    // Test advanced mode aria-label
    const { container: advancedContainer } = renderWithRouter("/app/advanced-chat")
    const advancedButton = advancedContainer.querySelector("button")
    expect(advancedButton?.getAttribute("aria-label")).toContain("standard")
  })
})
