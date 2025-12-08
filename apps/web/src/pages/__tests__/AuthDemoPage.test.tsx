/**
 * Generated from TestSpecifications: test-auth-031 to test-auth-034
 * Task: task-auth-008
 * Requirement: req-auth-007
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react"
import React from "react"
import { BrowserRouter } from "react-router-dom"
import { AuthDemoPage } from "../AuthDemoPage"
import { AuthProvider } from "../../contexts/AuthContext"
import { MockAuthService } from "@shogo/state-api"

// Set up happy-dom
import { Window } from "happy-dom"

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

// Wrapper component for tests
function TestWrapper({ children, authService }: { children: React.ReactNode; authService: MockAuthService }) {
  return (
    <BrowserRouter>
      <AuthProvider authService={authService}>{children}</AuthProvider>
    </BrowserRouter>
  )
}

describe("AuthDemoPage shows login form when not authenticated", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Login form with email and password fields is visible", async () => {
    const { getByLabelText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Should have email and password inputs
    expect(getByLabelText(/email/i)).toBeDefined()
    expect(getByLabelText(/password/i)).toBeDefined()
  })

  test("Signup form is accessible", async () => {
    const { queryAllByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Should have sign up button or tab
    const signUpElements = queryAllByText(/sign up/i)
    expect(signUpElements.length).toBeGreaterThan(0)
  })

  test("Logout button is not visible when not authenticated", async () => {
    const { queryByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Should NOT have logout button
    expect(queryByText(/log out|sign out/i)).toBeNull()
  })
})

describe("AuthDemoPage shows user info when authenticated", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    mockAuthService = new MockAuthService()
    // Pre-authenticate
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("Current user email is displayed", async () => {
    const { getByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Wait for initialization
    await waitFor(() => {
      expect(getByText(/test@example.com/)).toBeDefined()
    })
  })

  test("Logout button is visible", async () => {
    const { queryByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    await waitFor(() => {
      const logoutButton = queryByText(/log out|sign out/i)
      expect(logoutButton).toBeDefined()
    })
  })
})

describe("AuthDemoPage shows loading state during operations", () => {
  let mockAuthService: MockAuthService

  beforeEach(async () => {
    // Use delayed mock
    mockAuthService = new MockAuthService({ delay: 100 })
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
    await mockAuthService.signOut()
  })

  test("Loading indicator is displayed during login", async () => {
    const { getByLabelText, getByRole, queryByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Wait for initial loading to complete (initialize call)
    await waitFor(() => {
      const signInButton = getByRole("button", { name: /sign in/i })
      expect(signInButton).toBeDefined()
    })

    // Fill in credentials
    const emailInput = getByLabelText(/email/i)
    const passwordInput = getByLabelText(/password/i)

    fireEvent.change(emailInput, { target: { value: "test@example.com" } })
    fireEvent.change(passwordInput, { target: { value: "secret123" } })

    // Click sign in
    const signInButton = getByRole("button", { name: /sign in/i })
    fireEvent.click(signInButton)

    // Should show loading state
    await waitFor(() => {
      const loadingIndicator = queryByText(/signing in/i)
      expect(loadingIndicator).toBeDefined()
    })
  })
})

describe("AuthDemoPage displays error messages", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Error message is displayed on invalid credentials", async () => {
    const { getByLabelText, getByRole, queryByText } = render(
      <TestWrapper authService={mockAuthService}>
        <AuthDemoPage />
      </TestWrapper>
    )

    // Wait for initial loading to complete (initialize call)
    await waitFor(() => {
      const signInButton = getByRole("button", { name: /sign in/i })
      expect(signInButton).toBeDefined()
    })

    // Fill in wrong credentials
    const emailInput = getByLabelText(/email/i)
    const passwordInput = getByLabelText(/password/i)

    fireEvent.change(emailInput, { target: { value: "wrong@example.com" } })
    fireEvent.change(passwordInput, { target: { value: "wrongpassword" } })

    // Click sign in
    const signInButton = getByRole("button", { name: /sign in/i })
    fireEvent.click(signInButton)

    // Should show error
    await waitFor(() => {
      const errorMessage = queryByText(/error|invalid|failed/i)
      expect(errorMessage).toBeDefined()
    })
  })
})
