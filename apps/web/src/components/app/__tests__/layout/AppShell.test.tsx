/**
 * AppShell Component Tests
 * Task: task-2-1-011 (app-shell-component)
 *
 * Tests verify:
 * 1. Component renders with AppHeader at top
 * 2. Uses h-screen with flex flex-col layout
 * 3. Main content area has flex-1 and overflow-auto
 * 4. Renders React Router Outlet for nested route content
 * 5. Uses bg-background for main content area
 * 6. Structure supports future sidebar addition (Session 2.2)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test"
import { render, cleanup, waitFor } from "@testing-library/react"
import React, { useEffect } from "react"
import { Window } from "happy-dom"
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom"
import { EnvironmentProvider, createEnvironment } from "@/contexts/EnvironmentContext"
import { DomainProvider, useDomains } from "@/contexts/DomainProvider"
import { betterAuthDomain, MockAuthService } from "@shogo/state-api"
import { AppShell } from "../../layout/AppShell"

// Set up happy-dom
let happyDomWindow: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document
let originalLocalStorage: typeof globalThis.localStorage

beforeAll(() => {
  happyDomWindow = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  originalLocalStorage = globalThis.localStorage
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = happyDomWindow
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = happyDomWindow.document
  // @ts-expect-error - happy-dom localStorage type mismatch
  globalThis.localStorage = happyDomWindow.localStorage

  // Polyfill getComputedStyle for Radix UI components
  if (!globalThis.getComputedStyle) {
    // @ts-expect-error - polyfill
    globalThis.getComputedStyle = (element: Element) => ({
      getPropertyValue: () => "",
      animationName: "",
      animationDuration: "",
    })
  }

  // Polyfill requestAnimationFrame for Radix UI
  if (!globalThis.requestAnimationFrame) {
    // @ts-expect-error - polyfill
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      return setTimeout(() => callback(Date.now()), 16)
    }
  }

  // Polyfill cancelAnimationFrame
  if (!globalThis.cancelAnimationFrame) {
    // @ts-expect-error - polyfill
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id)
    }
  }
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  globalThis.localStorage = originalLocalStorage
  happyDomWindow.close()
})

afterEach(() => {
  cleanup()
  document.documentElement.className = ""
})

// Mock persistence for testing
const mockPersistence = {
  loadCollection: async () => null,
  saveCollection: async () => {},
  loadEntity: async () => null,
  saveEntity: async () => {},
  loadSchema: async () => null,
  listSchemas: async () => [],
}

/**
 * Wrapper component that initializes auth before rendering children.
 */
function AuthInitializer({ children }: { children: React.ReactNode }) {
  const { auth } = useDomains()

  useEffect(() => {
    auth.initialize()
  }, [auth])

  return <>{children}</>
}

// Helper to render AppShell with required providers and router
function renderAppShell(authService: MockAuthService, nestedContent?: React.ReactNode) {
  const env = createEnvironment({
    persistence: mockPersistence,
    auth: authService,
  })
  const domains = { auth: betterAuthDomain } as const

  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <EnvironmentProvider env={env}>
        <DomainProvider domains={domains}>
          <AuthInitializer>
            <Routes>
              <Route path="/app" element={<AppShell />}>
                <Route index element={nestedContent || <div data-testid="nested-content">Nested Route Content</div>} />
              </Route>
            </Routes>
          </AuthInitializer>
        </DomainProvider>
      </EnvironmentProvider>
    </MemoryRouter>
  )
}

// ============================================================
// Test: AppShell renders with AppHeader and content area
// Per test-2-1-011-shell-renders scenario
// ============================================================
describe("AppShell renders with AppHeader and content area", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    // Pre-authenticate user since AppShell is rendered inside authenticated context
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("AppHeader is rendered at top", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      // AppHeader renders as a <header> element
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.textContent).toContain("Shogo Studio")
    })
  })

  test("Main content area is rendered below header", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      // Main content area renders as a <main> element
      const main = container.querySelector("main")
      expect(main).not.toBeNull()
    })
  })

  test("Uses h-screen for full viewport height", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      // Root container should have h-screen class
      const rootDiv = container.firstElementChild
      expect(rootDiv).not.toBeNull()
      expect(rootDiv?.className).toContain("h-screen")
    })
  })
})

// ============================================================
// Test: AppShell uses flex column layout
// Per test-2-1-011-shell-layout scenario
// ============================================================
describe("AppShell uses flex column layout", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Uses flex flex-col layout", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const rootDiv = container.firstElementChild
      expect(rootDiv).not.toBeNull()
      expect(rootDiv?.className).toContain("flex")
      expect(rootDiv?.className).toContain("flex-col")
    })
  })

  test("Header has fixed height", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      // AppHeader uses h-14 (~56px)
      expect(header?.className).toContain("h-14")
    })
  })

  test("Main content area has flex-1 and overflow-auto", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const main = container.querySelector("main")
      expect(main).not.toBeNull()
      expect(main?.className).toContain("flex-1")
      expect(main?.className).toContain("overflow-auto")
    })
  })

  test("Uses bg-background for main content area", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const main = container.querySelector("main")
      expect(main).not.toBeNull()
      expect(main?.className).toContain("bg-background")
    })
  })
})

// ============================================================
// Test: AppShell renders React Router Outlet for nested routes
// Per test-2-1-011-shell-outlet scenario
// ============================================================
describe("AppShell renders React Router Outlet for nested routes", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Outlet component renders nested route content", async () => {
    const { queryByTestId } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const nestedContent = queryByTestId("nested-content")
      expect(nestedContent).not.toBeNull()
      expect(nestedContent?.textContent).toBe("Nested Route Content")
    })
  })

  test("Content appears in main content area below header", async () => {
    const { container, queryByTestId } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const main = container.querySelector("main")
      const nestedContent = queryByTestId("nested-content")

      expect(main).not.toBeNull()
      expect(nestedContent).not.toBeNull()

      // Nested content should be inside main
      expect(main?.contains(nestedContent)).toBe(true)
    })
  })

  test("Nested routes render inside the outlet", async () => {
    const customContent = <div data-testid="custom-nested">Custom Nested Page</div>
    const { queryByTestId } = renderAppShell(mockAuthService, customContent)

    await waitFor(() => {
      const customNested = queryByTestId("custom-nested")
      expect(customNested).not.toBeNull()
      expect(customNested?.textContent).toBe("Custom Nested Page")
    })
  })
})

// ============================================================
// Test: AppShell structure supports future sidebar addition
// Per acceptance criteria: "Structure supports future sidebar addition (Session 2.2)"
// ============================================================
describe("AppShell structure supports future sidebar addition", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Layout structure allows sidebar to be added alongside main content", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      // Verify the flex-col structure exists
      // Header at top, main below - this allows inserting a horizontal flex container
      // between header and main in Session 2.2
      const rootDiv = container.firstElementChild
      expect(rootDiv?.className).toContain("flex-col")

      // Header and main are direct children of root
      const header = container.querySelector("header")
      const main = container.querySelector("main")

      expect(header).not.toBeNull()
      expect(main).not.toBeNull()
    })
  })

  test("Main content area uses flex-1 to fill available space", async () => {
    const { container } = renderAppShell(mockAuthService)

    await waitFor(() => {
      const main = container.querySelector("main")
      expect(main).not.toBeNull()
      // flex-1 ensures main fills space, allowing sidebar to be placed alongside
      expect(main?.className).toContain("flex-1")
    })
  })
})

// ============================================================
// Test: AppShell component exports correctly
// ============================================================
describe("AppShell component exports", () => {
  test("AppShell is exported as named export", () => {
    expect(AppShell).toBeDefined()
    expect(typeof AppShell).toBe("function")
  })
})
