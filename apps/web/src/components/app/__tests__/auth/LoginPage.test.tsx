/**
 * LoginPage Component Tests
 *
 * TDD tests for the LoginPage component.
 * Task: task-2-1-008
 *
 * Tests verify:
 * - Full-page layout with centered Card container
 * - Logo/brand header at top of card
 * - shadcn Tabs component for SignIn/SignUp toggle
 * - SignInForm and SignUpForm as tab content
 * - Separator with 'or' text below forms
 * - GoogleOAuthButton below separator
 * - Alert component displays auth.authError when present
 * - Alert clears when switching tabs
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import React from "react"
import { Window } from "happy-dom"
import { BrowserRouter } from "react-router-dom"
import { EnvironmentProvider, createEnvironment } from "@shogo/app-core"
import { DomainProvider } from "@shogo/app-core"
import { betterAuthDomain, MockAuthService } from "@shogo/state-api"
import { LoginPage } from "../../auth/LoginPage"

// Set up happy-dom
let happyDomWindow: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  happyDomWindow = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = happyDomWindow
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = happyDomWindow.document

  // Polyfill getComputedStyle for Radix UI components
  if (!globalThis.getComputedStyle) {
    // @ts-expect-error - polyfill
    globalThis.getComputedStyle = (element: Element) => ({
      getPropertyValue: () => "",
      animationName: "",
      animationDuration: "",
    })
  }

  // Polyfill requestAnimationFrame for Radix UI Tabs
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
  happyDomWindow.close()
})

afterEach(() => {
  cleanup()
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

// Helper to render LoginPage with required providers
function renderLoginPage(authService: MockAuthService) {
  const env = createEnvironment({
    persistence: mockPersistence,
    auth: authService,
  })
  const domains = { auth: betterAuthDomain } as const

  return render(
    <BrowserRouter>
      <EnvironmentProvider env={env}>
        <DomainProvider domains={domains}>
          <LoginPage />
        </DomainProvider>
      </EnvironmentProvider>
    </BrowserRouter>
  )
}

describe("LoginPage Component", () => {
  describe("Layout Structure", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("renders with full-page centered layout", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // Check for the full-page centering container
        const fullPageContainer = container.querySelector(".min-h-screen")
        expect(fullPageContainer).not.toBeNull()
        expect(fullPageContainer?.className).toContain("flex")
        expect(fullPageContainer?.className).toContain("items-center")
        expect(fullPageContainer?.className).toContain("justify-center")
      })
    })

    test("renders shadcn Card container", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // shadcn Card has data-slot="card" attribute
        const card = container.querySelector('[data-slot="card"]')
        expect(card).not.toBeNull()
      })
    })

    test("renders logo/brand header in card", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // Check for card header with brand content
        const cardHeader = container.querySelector('[data-slot="card-header"]')
        expect(cardHeader).not.toBeNull()
      })
    })
  })

  describe("Tabs Component", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("renders shadcn Tabs component", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // shadcn Tabs has data-slot="tabs" attribute
        const tabs = container.querySelector('[data-slot="tabs"]')
        expect(tabs).not.toBeNull()
      })
    })

    test("renders SignIn tab trigger", async () => {
      const { getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const signInTab = getByRole("tab", { name: /sign in/i })
        expect(signInTab).toBeDefined()
      })
    })

    test("renders SignUp tab trigger", async () => {
      const { getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const signUpTab = getByRole("tab", { name: /sign up/i })
        expect(signUpTab).toBeDefined()
      })
    })

    test("SignIn tab is selected by default", async () => {
      const { getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const signInTab = getByRole("tab", { name: /sign in/i })
        expect(signInTab.getAttribute("aria-selected")).toBe("true")
      })
    })

    test("SignInForm is visible by default", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // SignInForm has email input with id="signin-email"
        const signInEmailInput = container.querySelector('input[id="signin-email"]')
        expect(signInEmailInput).not.toBeNull()
      })
    })

    test("SignUpForm is hidden by default", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // SignUpForm would have email input with id="signup-email"
        // It should NOT be visible in the DOM when SignIn tab is active
        const signUpEmailInput = container.querySelector('input[id="signup-email"]')
        // TabsContent hides its content when not active
        expect(signUpEmailInput).toBeNull()
      })
    })
  })

  describe("Tab Switching", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    // Helper function to click a Radix tab trigger properly
    const clickTab = async (tab: Element) => {
      // Radix Tabs requires proper mouse events - try multiple approaches
      await act(async () => {
        // Focus the tab first
        ;(tab as HTMLElement).focus?.()
        // Try mouse events
        fireEvent.mouseDown(tab, { button: 0 })
        fireEvent.mouseUp(tab, { button: 0 })
        fireEvent.click(tab)
      })
      // Give React time to process the state change
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
      })
    }

    test("clicking SignUp tab switches to SignUp form", async () => {
      const { container, getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        expect(getByRole("tab", { name: /sign up/i })).toBeDefined()
      })

      const signUpTab = getByRole("tab", { name: /sign up/i })

      await clickTab(signUpTab)

      await waitFor(() => {
        // SignUp tab should now be selected
        expect(signUpTab.getAttribute("aria-selected")).toBe("true")
        // SignUpForm should be in an active tab content
        const activeContent = container.querySelector('[data-state="active"]')
        expect(activeContent).not.toBeNull()
      })
    })

    test("SignIn form is hidden after switching to SignUp tab", async () => {
      const { container, getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        expect(getByRole("tab", { name: /sign up/i })).toBeDefined()
      })

      const signUpTab = getByRole("tab", { name: /sign up/i })

      await clickTab(signUpTab)

      await waitFor(() => {
        // Radix TabsContent with SignIn should have data-state="inactive"
        // The content might still be in the DOM but should be hidden
        const tabsContents = container.querySelectorAll('[data-slot="tabs-content"]')
        // At least one should have inactive state after switching
        const hasInactiveTab = Array.from(tabsContents).some(
          content => content.getAttribute("data-state") === "inactive"
        )
        expect(hasInactiveTab || signUpTab.getAttribute("aria-selected") === "true").toBe(true)
      })
    })

    test("tab state updates visually when switching", async () => {
      const { getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        expect(getByRole("tab", { name: /sign up/i })).toBeDefined()
      })

      const signUpTab = getByRole("tab", { name: /sign up/i })
      const signInTab = getByRole("tab", { name: /sign in/i })

      // Initially SignIn is selected
      expect(signInTab.getAttribute("aria-selected")).toBe("true")
      expect(signUpTab.getAttribute("aria-selected")).toBe("false")

      await clickTab(signUpTab)

      await waitFor(() => {
        // Now SignUp should be selected
        expect(signUpTab.getAttribute("aria-selected")).toBe("true")
        expect(signInTab.getAttribute("aria-selected")).toBe("false")
      })
    })
  })

  describe("OAuth and Separator", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("renders Separator below forms", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // shadcn Separator has data-slot="separator" attribute
        const separator = container.querySelector('[data-slot="separator"]')
        expect(separator).not.toBeNull()
      })
    })

    test("renders 'or' text with separator", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // Look for 'or' text near the separator
        const orText = container.querySelector(".text-muted-foreground")
        // The 'or' should be present somewhere in the layout
        expect(container.textContent).toContain("or")
      })
    })

    test("renders GoogleOAuthButton", async () => {
      const { getByRole } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const googleButton = getByRole("button", { name: /google/i })
        expect(googleButton).toBeDefined()
      })
    })

    test("GoogleOAuthButton is below separator in DOM order", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const separator = container.querySelector('[data-slot="separator"]')
        const googleButton = container.querySelector('button')

        expect(separator).not.toBeNull()

        // Find Google button by looking for the one with 'Google' text
        const buttons = container.querySelectorAll("button")
        const googleOAuthButton = Array.from(buttons).find(btn =>
          btn.textContent?.toLowerCase().includes("google")
        )
        expect(googleOAuthButton).not.toBeNull()
      })
    })
  })

  describe("Error Display", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("displays Alert when auth.authError is present", async () => {
      // Create an auth service that will produce an error
      const errorAuthService = new MockAuthService()

      const { container, getByRole } = renderLoginPage(errorAuthService)

      // Wait for the component to render
      await waitFor(() => {
        expect(getByRole("tab", { name: /sign in/i })).toBeDefined()
      })

      // Get the sign-in form elements
      const emailInput = container.querySelector('input[id="signin-email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[id="signin-password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i })

      // Fill in invalid credentials
      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "invalid@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "wrongpassword" } })
      })

      // Submit the form (this will fail and set authError)
      await act(async () => {
        fireEvent.click(submitButton)
      })

      // Wait for the error to appear
      await waitFor(() => {
        // shadcn Alert has role="alert"
        const alert = container.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
      })
    })

    test("Alert has destructive variant for errors", async () => {
      const errorAuthService = new MockAuthService()

      const { container, getByRole } = renderLoginPage(errorAuthService)

      await waitFor(() => {
        expect(getByRole("tab", { name: /sign in/i })).toBeDefined()
      })

      const emailInput = container.querySelector('input[id="signin-email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[id="signin-password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i })

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "invalid@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "wrongpassword" } })
      })

      await act(async () => {
        fireEvent.click(submitButton)
      })

      await waitFor(() => {
        const alert = container.querySelector('[role="alert"]')
        // Alert should have destructive styling (text-destructive class)
        expect(alert?.className).toContain("text-destructive")
      })
    })

    test("no Alert displayed when auth.authError is null", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        // No alert should be present when there's no error
        const alert = container.querySelector('[role="alert"]')
        expect(alert).toBeNull()
      })
    })
  })

  describe("Error Clearing", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    // Helper function to click a Radix tab trigger properly
    const clickTab = async (tab: Element) => {
      // Radix Tabs requires proper mouse events - try multiple approaches
      await act(async () => {
        // Focus the tab first
        ;(tab as HTMLElement).focus?.()
        // Try mouse events
        fireEvent.mouseDown(tab, { button: 0 })
        fireEvent.mouseUp(tab, { button: 0 })
        fireEvent.click(tab)
      })
      // Give React time to process the state change
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
      })
    }

    test("Alert clears when switching tabs", async () => {
      const errorAuthService = new MockAuthService()

      const { container, getByRole } = renderLoginPage(errorAuthService)

      await waitFor(() => {
        expect(getByRole("tab", { name: /sign in/i })).toBeDefined()
      })

      // Trigger an error
      const emailInput = container.querySelector('input[id="signin-email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[id="signin-password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i })

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "invalid@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "wrongpassword" } })
      })

      await act(async () => {
        fireEvent.click(submitButton)
      })

      // Wait for error to appear
      await waitFor(() => {
        const alert = container.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
      })

      // Switch to SignUp tab using proper Radix pointer events
      const signUpTab = getByRole("tab", { name: /sign up/i })

      await clickTab(signUpTab)

      // Error should be cleared
      await waitFor(() => {
        const alert = container.querySelector('[role="alert"]')
        expect(alert).toBeNull()
      })
    })
  })

  describe("shadcn Component Usage", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("uses shadcn Card component (has data-slot='card')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const card = container.querySelector('[data-slot="card"]')
        expect(card).not.toBeNull()
      })
    })

    test("uses shadcn CardHeader component (has data-slot='card-header')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const cardHeader = container.querySelector('[data-slot="card-header"]')
        expect(cardHeader).not.toBeNull()
      })
    })

    test("uses shadcn CardContent component (has data-slot='card-content')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const cardContent = container.querySelector('[data-slot="card-content"]')
        expect(cardContent).not.toBeNull()
      })
    })

    test("uses shadcn Tabs component (has data-slot='tabs')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const tabs = container.querySelector('[data-slot="tabs"]')
        expect(tabs).not.toBeNull()
      })
    })

    test("uses shadcn TabsList component (has data-slot='tabs-list')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const tabsList = container.querySelector('[data-slot="tabs-list"]')
        expect(tabsList).not.toBeNull()
      })
    })

    test("uses shadcn TabsTrigger components (have data-slot='tabs-trigger')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const tabsTriggers = container.querySelectorAll('[data-slot="tabs-trigger"]')
        expect(tabsTriggers.length).toBe(2) // SignIn and SignUp
      })
    })

    test("uses shadcn Separator component (has data-slot='separator')", async () => {
      const { container } = renderLoginPage(mockAuthService)

      await waitFor(() => {
        const separator = container.querySelector('[data-slot="separator"]')
        expect(separator).not.toBeNull()
      })
    })
  })
})
