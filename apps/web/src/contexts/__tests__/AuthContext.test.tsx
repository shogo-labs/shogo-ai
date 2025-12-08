/**
 * Generated from TestSpecifications: test-auth-026 to test-auth-030
 * Task: task-auth-007
 * Requirement: req-auth-006
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, waitFor, act, cleanup } from "@testing-library/react"
import React, { useEffect, useState } from "react"
import { AuthProvider, useAuth } from "../AuthContext"
import { MockAuthService, type AuthSession } from "@shogo/state-api"
import { observer } from "mobx-react-lite"

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

describe("AuthProvider creates stable store instance", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Store instance remains the same (useRef stability)", async () => {
    const storeInstances: any[] = []

    function TestComponent() {
      const authStore = useAuth()
      storeInstances.push(authStore)
      return <div>Test</div>
    }

    const { rerender } = render(
      <AuthProvider authService={mockAuthService}>
        <TestComponent />
      </AuthProvider>
    )

    // Force re-render
    rerender(
      <AuthProvider authService={mockAuthService}>
        <TestComponent />
      </AuthProvider>
    )

    // Both renders should return the same store instance
    expect(storeInstances.length).toBe(2)
    expect(storeInstances[0]).toBe(storeInstances[1])
  })
})

describe("AuthProvider subscribes to auth state changes", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Store is updated with new auth state", async () => {
    // Set up user in mock service first
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
    await mockAuthService.signOut()

    const ObserverComponent = observer(function TestComponent() {
      const authStore = useAuth()
      return <div data-testid="auth-status">{authStore.isAuthenticated ? "authenticated" : "not-authenticated"}</div>
    })

    const { getByTestId } = render(
      <AuthProvider authService={mockAuthService}>
        <ObserverComponent />
      </AuthProvider>
    )

    // Initially not authenticated
    expect(getByTestId("auth-status").textContent).toBe("not-authenticated")

    // Sign in via mock service
    await act(async () => {
      await mockAuthService.signIn({ email: "test@example.com", password: "secret123" })
    })

    // Store should sync with auth state change
    await waitFor(() => {
      expect(getByTestId("auth-status").textContent).toBe("authenticated")
    })
  })
})

describe("AuthProvider cleans up subscription on unmount", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Unsubscribe function is called on unmount", () => {
    let unsubscribeCalled = false
    const originalOnAuthStateChange = mockAuthService.onAuthStateChange.bind(mockAuthService)

    mockAuthService.onAuthStateChange = (callback: (session: AuthSession | null) => void) => {
      const unsubscribe = originalOnAuthStateChange(callback)
      return () => {
        unsubscribeCalled = true
        unsubscribe()
      }
    }

    function TestComponent() {
      const authStore = useAuth()
      return <div>{authStore.isAuthenticated ? "auth" : "no-auth"}</div>
    }

    const { unmount } = render(
      <AuthProvider authService={mockAuthService}>
        <TestComponent />
      </AuthProvider>
    )

    // Unmount
    unmount()

    // Unsubscribe should have been called
    expect(unsubscribeCalled).toBe(true)
  })
})

describe("useAuth throws outside AuthProvider", () => {
  test("Throws error with message about missing AuthProvider", () => {
    // Suppress React error boundary warnings for this test
    const originalError = console.error
    console.error = () => {}

    function TestComponent() {
      useAuth()
      return <div>Should not render</div>
    }

    expect(() => {
      render(<TestComponent />)
    }).toThrow("useAuth must be used within AuthProvider")

    console.error = originalError
  })
})

describe("useAuth provides access to store actions", () => {
  let mockAuthService: MockAuthService

  beforeEach(() => {
    mockAuthService = new MockAuthService()
  })

  test("Component calls store.signIn via useAuth", async () => {
    // Pre-register user
    await mockAuthService.signUp({ email: "test@example.com", password: "secret123" })
    await mockAuthService.signOut()

    const ObserverComponent = observer(function TestComponent() {
      const authStore = useAuth()
      const [status, setStatus] = useState("idle")

      const handleSignIn = async () => {
        setStatus("signing-in")
        await authStore.signIn({ email: "test@example.com", password: "secret123" })
        setStatus("signed-in")
      }

      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="auth">{authStore.isAuthenticated ? "yes" : "no"}</span>
          <button data-testid="signin-btn" onClick={handleSignIn}>
            Sign In
          </button>
        </div>
      )
    })

    const { getByTestId } = render(
      <AuthProvider authService={mockAuthService}>
        <ObserverComponent />
      </AuthProvider>
    )

    expect(getByTestId("auth").textContent).toBe("no")

    // Click sign in
    await act(async () => {
      getByTestId("signin-btn").click()
    })

    await waitFor(() => {
      expect(getByTestId("status").textContent).toBe("signed-in")
      expect(getByTestId("auth").textContent).toBe("yes")
    })
  })

  test("Component can observe isAuthenticated change", async () => {
    const ObserverComponent = observer(function TestComponent() {
      const authStore = useAuth()

      useEffect(() => {
        // Sign up on mount
        authStore.signUp({ email: "test@example.com", password: "secret123" })
      }, [])

      return <div data-testid="auth">{authStore.isAuthenticated ? "authenticated" : "not-authenticated"}</div>
    })

    const { getByTestId } = render(
      <AuthProvider authService={mockAuthService}>
        <ObserverComponent />
      </AuthProvider>
    )

    // Wait for sign up to complete
    await waitFor(() => {
      expect(getByTestId("auth").textContent).toBe("authenticated")
    })
  })
})
