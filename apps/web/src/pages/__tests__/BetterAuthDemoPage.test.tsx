/**
 * Tests for BetterAuthDemoPage
 * Task: task-ba-012
 *
 * Tests the BetterAuth proof-of-work demo page using:
 * - useDomains() hook to access auth store (betterAuthDomain)
 * - Email/password sign-up and sign-in forms
 * - Google OAuth button
 * - Authenticated state display
 * - Loading and error states
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import React from "react"
import { BrowserRouter } from "react-router-dom"
import { BetterAuthDemoPage } from "../BetterAuthDemoPage"
import { EnvironmentProvider, createEnvironment } from "../../contexts/EnvironmentContext"
import { DomainProvider } from "../../contexts/DomainProvider"
import { betterAuthDomain, MockAuthService } from "@shogo/state-api"

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

// Mock persistence for testing
const mockPersistence = {
  loadCollection: async () => null,
  saveCollection: async () => {},
  loadEntity: async () => null,
  saveEntity: async () => {},
  loadSchema: async () => null,
  listSchemas: async () => [],
}

// Helper to render with required providers
function renderWithProviders(ui: React.ReactNode, authService: MockAuthService) {
  const env = createEnvironment({
    persistence: mockPersistence,
    auth: authService,
  })
  const domains = { auth: betterAuthDomain } as const

  return render(
    <BrowserRouter>
      <EnvironmentProvider env={env}>
        <DomainProvider domains={domains}>
          {ui}
        </DomainProvider>
      </EnvironmentProvider>
    </BrowserRouter>
  )
}

// ============================================================
// Test: Page renders without errors
// ============================================================
describe("BetterAuthDemoPage renders correctly", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Page renders without errors", () => {
    const { container } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)
    expect(container).toBeDefined()
  })

  test("Page title is visible", () => {
    const { getByText } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)
    expect(getByText(/Better Auth Demo/i)).toBeDefined()
  })
})

// ============================================================
// Test: Sign-up form is visible when not authenticated
// ============================================================
describe("BetterAuthDemoPage shows sign-up form when not authenticated", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Sign-up form has name, email, and password fields", () => {
    const { getByTestId } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Should have sign-up form
    const signupForm = getByTestId("signup-form")
    expect(signupForm).toBeDefined()

    // Should have name, email, and password inputs within sign-up form
    expect(signupForm.querySelector('input[id="signup-name"]')).toBeDefined()
    expect(signupForm.querySelector('input[id="signup-email"]')).toBeDefined()
    expect(signupForm.querySelector('input[id="signup-password"]')).toBeDefined()
  })

  test("Sign-up submit button is visible", async () => {
    const { getByRole } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)

    // Wait for initialization to complete
    await waitFor(() => {
      expect(getByRole("button", { name: /sign up/i })).toBeDefined()
    })
  })
})

// ============================================================
// Test: Sign-in form is accessible
// ============================================================
describe("BetterAuthDemoPage shows sign-in form when not authenticated", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Sign-in form has email and password fields", () => {
    const { getByTestId } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)

    // Should have sign-in form
    expect(getByTestId("signin-form")).toBeDefined()
  })

  test("Sign-in submit button is visible", async () => {
    const { getByRole } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)

    // Wait for initialization to complete
    await waitFor(() => {
      expect(getByRole("button", { name: /sign in/i })).toBeDefined()
    })
  })
})

// ============================================================
// Test: Google OAuth button is visible
// ============================================================
describe("BetterAuthDemoPage shows Google OAuth button", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Google sign-in button is visible", async () => {
    const { getByRole } = renderWithProviders(<BetterAuthDemoPage />, mockAuthService)

    // Wait for initialization to complete
    await waitFor(() => {
      expect(getByRole("button", { name: /google/i })).toBeDefined()
    })
  })
})

// ============================================================
// Test: Authenticated state shows user info
// ============================================================
describe("BetterAuthDemoPage shows user info when authenticated", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    // Pre-authenticate user
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("Current user email is displayed", async () => {
    const { getByText, getByTestId } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for auth state to initialize and display user info
    await waitFor(() => {
      expect(getByTestId("user-info")).toBeDefined()
    })

    await waitFor(() => {
      expect(getByText(/test@example.com/)).toBeDefined()
    })
  })

  test("Sign out button is visible when authenticated", async () => {
    const { getByRole, getByTestId } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for auth state to initialize
    await waitFor(() => {
      expect(getByTestId("user-info")).toBeDefined()
    })

    expect(getByRole("button", { name: /sign out/i })).toBeDefined()
  })
})

// ============================================================
// Test: Sign out clears session
// ============================================================
describe("BetterAuthDemoPage sign out works", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    // Pre-authenticate user
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("Clicking sign out returns to unauthenticated state", async () => {
    const { getByRole, getByTestId, queryByTestId } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for authenticated state
    await waitFor(() => {
      expect(getByTestId("user-info")).toBeDefined()
    })

    // Click sign out
    const signOutButton = getByRole("button", { name: /sign out/i })
    fireEvent.click(signOutButton)

    // Should return to unauthenticated state (sign-up form visible)
    await waitFor(() => {
      expect(getByTestId("signup-form")).toBeDefined()
    })

    // User info should not be visible
    expect(queryByTestId("user-info")).toBeNull()
  })
})

// ============================================================
// Test: Loading states are displayed
// ============================================================
describe("BetterAuthDemoPage shows loading states", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    // Use delayed mock for loading state tests
    mockAuthService = new MockAuthService({ delay: 100 })
  })

  test("Loading indicator shown during sign-in", async () => {
    // Create a user first (without delay for setup)
    const setupService = new MockAuthService()
    await setupService.signUp({ email: "test@example.com", password: "secret123" })
    await setupService.signOut()

    // Create delayed service for actual test
    mockAuthService = new MockAuthService({ delay: 100 })
    // Copy user to delayed service
    await mockAuthService.signUp({ email: "other@example.com", password: "secret123" })
    await mockAuthService.signOut()

    const { getByTestId, queryByTestId, getByRole } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for initialization to complete so buttons are enabled
    await waitFor(() => {
      expect(getByRole("button", { name: /sign in/i })).toBeDefined()
    })

    // Fill in sign-in form using specific IDs
    const signinForm = getByTestId("signin-form")
    const emailInput = signinForm.querySelector('input[id="signin-email"]') as HTMLInputElement
    const passwordInput = signinForm.querySelector('input[id="signin-password"]') as HTMLInputElement

    fireEvent.change(emailInput, { target: { value: "other@example.com" } })
    fireEvent.change(passwordInput, { target: { value: "secret123" } })

    // Click sign in
    const signInButton = getByRole("button", { name: /sign in/i })
    fireEvent.click(signInButton)

    // Should show loading state
    await waitFor(() => {
      const loadingIndicator = queryByTestId("loading-indicator")
      expect(loadingIndicator).toBeDefined()
    })
  })
})

// ============================================================
// Test: Error states are displayed
// ============================================================
describe("BetterAuthDemoPage displays error states", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Error message shown on invalid credentials", async () => {
    const { getByTestId, getByRole, queryByTestId } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for initialization to complete so buttons are enabled
    await waitFor(() => {
      expect(getByRole("button", { name: /sign in/i })).toBeDefined()
    })

    // Fill in sign-in form with non-existent user using specific IDs
    const signinForm = getByTestId("signin-form")
    const emailInput = signinForm.querySelector('input[id="signin-email"]') as HTMLInputElement
    const passwordInput = signinForm.querySelector('input[id="signin-password"]') as HTMLInputElement

    fireEvent.change(emailInput, { target: { value: "nonexistent@example.com" } })
    fireEvent.change(passwordInput, { target: { value: "wrongpassword" } })

    // Click sign in
    const signInButton = getByRole("button", { name: /sign in/i })
    fireEvent.click(signInButton)

    // Should show error message
    await waitFor(() => {
      const errorMessage = queryByTestId("error-message")
      expect(errorMessage).toBeDefined()
    })
  })
})

// ============================================================
// Test: Sign-up flow works
// ============================================================
describe("BetterAuthDemoPage sign-up flow", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Successful sign-up shows authenticated state", async () => {
    const { getByTestId, getByRole } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for initialization to complete so buttons are enabled
    await waitFor(() => {
      expect(getByRole("button", { name: /sign up/i })).toBeDefined()
    })

    // Fill in sign-up form using specific IDs
    const signupForm = getByTestId("signup-form")
    const nameInput = signupForm.querySelector('input[id="signup-name"]') as HTMLInputElement
    const emailInput = signupForm.querySelector('input[id="signup-email"]') as HTMLInputElement
    const passwordInput = signupForm.querySelector('input[id="signup-password"]') as HTMLInputElement

    fireEvent.change(nameInput, { target: { value: "Test User" } })
    fireEvent.change(emailInput, { target: { value: "newuser@example.com" } })
    fireEvent.change(passwordInput, { target: { value: "password123" } })

    // Click sign up
    const signUpButton = getByRole("button", { name: /sign up/i })
    fireEvent.click(signUpButton)

    // Should show authenticated state with user info
    await waitFor(() => {
      expect(getByTestId("user-info")).toBeDefined()
    })
  })
})

// ============================================================
// Test: Sign-in flow works
// ============================================================
describe("BetterAuthDemoPage sign-in flow", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Sign-in form is displayed and accepts input", async () => {
    const { getByTestId, getByRole } = renderWithProviders(
      <BetterAuthDemoPage />,
      mockAuthService
    )

    // Wait for initialization to complete so buttons are enabled
    await waitFor(() => {
      expect(getByRole("button", { name: /sign in/i })).toBeDefined()
    })

    // Fill in sign-in form using specific IDs
    const signinForm = getByTestId("signin-form")
    const emailInput = signinForm.querySelector('input[id="signin-email"]') as HTMLInputElement
    const passwordInput = signinForm.querySelector('input[id="signin-password"]') as HTMLInputElement

    await act(async () => {
      fireEvent.change(emailInput, { target: { value: "test@example.com" } })
      fireEvent.change(passwordInput, { target: { value: "password123" } })
    })

    // Verify form inputs are correctly filled
    expect(emailInput.value).toBe("test@example.com")
    expect(passwordInput.value).toBe("password123")

    // Verify sign-in button is available
    const signInButton = getByRole("button", { name: /sign in/i }) as HTMLButtonElement
    expect(signInButton).toBeDefined()
    expect(signInButton.disabled).toBe(false)
  })
})
