/**
 * AppHeader Component Tests
 * Task: task-2-1-010 (app-header-component)
 *
 * Tests verify:
 * 1. Component renders with logo/brand on left side
 * 2. Spacer (flex-1) in middle for future org/project selectors
 * 3. ThemeToggle and UserMenu on right side
 * 4. Fixed height ~56px with border-bottom
 * 5. Uses bg-card background color
 * 6. Uses Tailwind flex layout: flex items-center justify-between
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, cleanup, waitFor } from "@testing-library/react"
import React, { useEffect } from "react"
import { AppHeader } from "../../layout/AppHeader"
import { EnvironmentProvider, createEnvironment } from "../../../../contexts/EnvironmentContext"
import { DomainProvider, useDomains } from "../../../../contexts/DomainProvider"
import { betterAuthDomain, MockAuthService } from "@shogo/state-api"

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
 * This simulates what AppShell/AuthGate would do in the real app.
 */
function AuthInitializer({ children }: { children: React.ReactNode }) {
  const { auth } = useDomains()

  useEffect(() => {
    auth.initialize()
  }, [auth])

  return <>{children}</>
}

// Helper to render with required providers
function renderWithProviders(ui: React.ReactNode, authService: MockAuthService) {
  const env = createEnvironment({
    persistence: mockPersistence,
    auth: authService,
  })
  const domains = { auth: betterAuthDomain } as const

  return render(
    <EnvironmentProvider env={env}>
      <DomainProvider domains={domains}>
        <AuthInitializer>{ui}</AuthInitializer>
      </DomainProvider>
    </EnvironmentProvider>
  )
}

// ============================================================
// Test: AppHeader renders with logo and user controls
// Per test-2-1-021 scenario
// ============================================================
describe("AppHeader renders with logo and user controls", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    // Pre-authenticate user
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Logo or brand is visible on left side", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    // Header should contain brand/logo text
    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.textContent).toContain("Shogo Studio")
    })
  })

  test("ThemeToggle is visible on right side", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    // ThemeToggle button should be present (has aria-label for theme switching)
    await waitFor(() => {
      const themeToggleButton = container.querySelector('button[aria-label*="mode"]')
      expect(themeToggleButton).not.toBeNull()
    })
  })

  test("UserMenu is visible on right side", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    // UserMenu should be present (Avatar with dropdown trigger)
    await waitFor(() => {
      const avatar = container.querySelector('[data-slot="avatar"]')
      expect(avatar).not.toBeNull()
    })
  })

  test("Header has fixed height ~56px with border-bottom", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      // h-14 = 56px (14 * 4px)
      expect(header?.className).toContain("h-14")
      // border-b for bottom border
      expect(header?.className).toContain("border-b")
    })
  })
})

// ============================================================
// Test: AppHeader uses correct Tailwind layout classes
// Per test-2-1-022 scenario
// ============================================================
describe("AppHeader uses correct Tailwind layout classes", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Header uses flex items-center", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.className).toContain("flex")
      expect(header?.className).toContain("items-center")
    })
  })

  test("Header has bg-card background color", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.className).toContain("bg-card")
    })
  })

  test("Header has proper border styling", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.className).toContain("border-b")
    })
  })
})

// ============================================================
// Test: AppHeader has spacer for future org/project selectors
// Per test-2-1-010-header-spacer scenario
// ============================================================
describe("AppHeader has spacer for future org/project selectors", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Spacer element with flex-1 exists in middle", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()

      // Find the spacer element - it should be a div with flex-1
      const spacer = header?.querySelector(".flex-1")
      expect(spacer).not.toBeNull()
    })
  })

  test("Structure supports adding OrgSwitcher and ProjectSelector in Session 2.2", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()

      // The header should have at least 3 child sections:
      // 1. Left side (logo)
      // 2. Middle spacer (flex-1)
      // 3. Right side (controls)
      const children = header?.children
      expect(children?.length).toBeGreaterThanOrEqual(3)
    })
  })
})

// ============================================================
// Test: AppHeader component structure
// ============================================================
describe("AppHeader component structure", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    await mockAuthService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Renders as semantic header element", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.tagName).toBe("HEADER")
    })
  })

  test("Has horizontal padding", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()
      // px-4 or similar padding class
      expect(header?.className).toMatch(/px-\d/)
    })
  })

  test("Left section contains logo/brand", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()

      // First child should be the left section containing the brand
      const leftSection = header?.children[0]
      expect(leftSection?.textContent).toContain("Shogo Studio")
    })
  })

  test("Right section contains ThemeToggle and UserMenu", async () => {
    const { container } = renderWithProviders(<AppHeader />, mockAuthService)

    await waitFor(() => {
      const header = container.querySelector("header")
      expect(header).not.toBeNull()

      // Last child should be the right section with controls
      const children = header?.children
      const rightSection = children?.[children.length - 1]

      // Right section should contain both ThemeToggle (button) and UserMenu (avatar)
      const themeToggle = rightSection?.querySelector('button[aria-label*="mode"]')
      const userMenu = rightSection?.querySelector('[data-slot="avatar"]')

      expect(themeToggle).not.toBeNull()
      expect(userMenu).not.toBeNull()
    })
  })
})
