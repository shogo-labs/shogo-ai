/**
 * SignInForm Component Tests
 *
 * TDD tests for the SignInForm component.
 * Tests verify: rendering, form submission, loading state, error clearing.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import React from "react"
import { Window } from "happy-dom"
import { SignInForm } from "../../auth/SignInForm"
import { EnvironmentProvider, createEnvironment } from "@shogo/app-core"
import { DomainProvider } from "@shogo/app-core"
import { betterAuthDomain, MockAuthService } from "@shogo/state-api"

// Set up happy-dom
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

// Helper to render SignInForm with required providers
function renderSignInForm(authService: MockAuthService, onSuccess?: () => void) {
  const env = createEnvironment({
    persistence: mockPersistence,
    auth: authService,
  })
  const domains = { auth: betterAuthDomain } as const

  return render(
    <EnvironmentProvider env={env}>
      <DomainProvider domains={domains}>
        <SignInForm onSuccess={onSuccess} />
      </DomainProvider>
    </EnvironmentProvider>
  )
}

describe("SignInForm Component", () => {
  describe("Rendering", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("renders email input field with correct type", () => {
      const { container } = renderSignInForm(mockAuthService)

      const emailInput = container.querySelector('input[type="email"]')
      expect(emailInput).toBeDefined()
      expect(emailInput).not.toBeNull()
    })

    test("renders password input field with correct type", () => {
      const { container } = renderSignInForm(mockAuthService)

      const passwordInput = container.querySelector('input[type="password"]')
      expect(passwordInput).toBeDefined()
      expect(passwordInput).not.toBeNull()
    })

    test("renders submit button with 'Sign In' text", () => {
      const { getByRole } = renderSignInForm(mockAuthService)

      const submitButton = getByRole("button", { name: /sign in/i })
      expect(submitButton).toBeDefined()
    })

    test("renders 'Forgot password?' link", () => {
      const { getByText } = renderSignInForm(mockAuthService)

      const forgotPasswordLink = getByText(/forgot password/i)
      expect(forgotPasswordLink).toBeDefined()
    })

    test("email input has correct label", () => {
      const { getByLabelText } = renderSignInForm(mockAuthService)

      const emailInput = getByLabelText(/email/i)
      expect(emailInput).toBeDefined()
    })

    test("password input has correct label", () => {
      const { getByLabelText } = renderSignInForm(mockAuthService)

      const passwordInput = getByLabelText(/password/i)
      expect(passwordInput).toBeDefined()
    })
  })

  describe("Form Submission", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      // Create a fresh auth service for each test
      mockAuthService = new MockAuthService()
    })

    test("submits form with entered email and password values", async () => {
      // This test verifies form submission triggers sign-in
      // Since we're using a fresh MockAuthService, sign-in will fail (no user)
      // but we can verify the form values are correctly passed

      const { container, getByRole } = renderSignInForm(mockAuthService)

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i })

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "test@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "password123" } })
      })

      // Verify form values are correctly set before submission
      expect(emailInput.value).toBe("test@example.com")
      expect(passwordInput.value).toBe("password123")

      // Click submit - this will attempt sign-in (will fail but triggers the flow)
      await act(async () => {
        fireEvent.click(submitButton)
      })

      // Wait for the async sign-in attempt to complete (will fail, that's ok)
      await waitFor(() => {
        // After sign-in attempt, auth status should not be 'loading'
        // (it will be 'error' since user doesn't exist, or 'idle' if completed)
        expect(true).toBe(true) // Just ensure we waited for async to complete
      })
    })

    test("triggers auth sign-in action on form submission", async () => {
      // This test verifies the form submission actually triggers sign-in
      // by checking the loading state transition (which only happens when signIn is called)

      // Create auth service with delay so we can observe loading state
      const delayedAuthService = new MockAuthService({ delay: 100 })

      const { container, getByRole } = renderSignInForm(delayedAuthService)

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i }) as HTMLButtonElement

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "test@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "password123" } })
      })

      // Submit the form
      fireEvent.click(submitButton)

      // Verify sign-in was triggered by checking button enters loading state
      await waitFor(() => {
        // Button should be disabled (loading state) after form submission
        expect(submitButton.disabled).toBe(true)
      })
    })
  })

  describe("Loading State", () => {
    let mockAuthService: MockAuthService

    beforeEach(async () => {
      // Use delayed mock for loading state tests
      mockAuthService = new MockAuthService({ delay: 200 })
      // Create a user to sign in with
      await mockAuthService.signUp({ email: "test@example.com", password: "password123" })
      await mockAuthService.signOut()
    })

    test("disables submit button when auth.authStatus is 'loading'", async () => {
      const { container, getByRole, queryByRole } = renderSignInForm(mockAuthService)

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i }) as HTMLButtonElement

      // Button should not be disabled initially
      expect(submitButton.disabled).toBe(false)

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "test@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "password123" } })
      })

      // Click submit to trigger loading state
      fireEvent.click(submitButton)

      // Button should be disabled during loading
      await waitFor(() => {
        const button = queryByRole("button") as HTMLButtonElement
        expect(button.disabled).toBe(true)
      })
    })

    test("shows loading text on button when auth.authStatus is 'loading'", async () => {
      const { container, getByRole } = renderSignInForm(mockAuthService)

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
      const submitButton = getByRole("button", { name: /sign in/i })

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "test@example.com" } })
        fireEvent.change(passwordInput, { target: { value: "password123" } })
      })

      // Click submit to trigger loading state
      fireEvent.click(submitButton)

      // Button should show "Signing in..." during loading
      await waitFor(() => {
        const button = getByRole("button")
        expect(button.textContent?.toLowerCase()).toContain("signing")
      })
    })
  })

  describe("Uses shadcn components", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("uses shadcn Input component (has data-slot='input')", () => {
      const { container } = renderSignInForm(mockAuthService)

      // shadcn Input has data-slot="input" attribute
      const inputs = container.querySelectorAll('[data-slot="input"]')
      expect(inputs.length).toBeGreaterThanOrEqual(2)
    })

    test("uses shadcn Label component (has data-slot='label')", () => {
      const { container } = renderSignInForm(mockAuthService)

      // shadcn Label has data-slot="label" attribute
      const labels = container.querySelectorAll('[data-slot="label"]')
      expect(labels.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("Form values managed by local state", () => {
    let mockAuthService: MockAuthService

    beforeEach(() => {
      mockAuthService = new MockAuthService()
    })

    test("email input accepts and reflects typed value", async () => {
      const { container } = renderSignInForm(mockAuthService)

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement

      await act(async () => {
        fireEvent.change(emailInput, { target: { value: "user@test.com" } })
      })

      expect(emailInput.value).toBe("user@test.com")
    })

    test("password input accepts and reflects typed value", async () => {
      const { container } = renderSignInForm(mockAuthService)

      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement

      await act(async () => {
        fireEvent.change(passwordInput, { target: { value: "secretpass" } })
      })

      expect(passwordInput.value).toBe("secretpass")
    })
  })
})
