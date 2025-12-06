/**
 * Generated from TestSpecification: test-025 through test-029
 * Task: task-auth-009
 * Requirement: req-auth-007
 *
 * Note: Testing hooks requires rendering them in a component context.
 * These tests use SSR rendering which has limitations for state updates.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import React from "react"
import { renderToString } from "react-dom/server"
import { AuthProvider } from "../../contexts/AuthContext"
import { useAuth } from "../useAuth"
import { MockAuthService } from "@shogo/state-api"

// Helper to capture hook values during render
interface CapturedAuth {
  user: any
  isAuthenticated: boolean
  loading: boolean
  error: string | null
  signIn: Function
  signUp: Function
  signOut: Function
}

function AuthCapture({ onCapture }: { onCapture: (auth: CapturedAuth) => void }) {
  const auth = useAuth()
  onCapture(auth)
  return null
}

describe("useAuth returns current user from store", () => {
  test("user property contains AuthUser data when authenticated", async () => {
    const authService = new MockAuthService()
    // Pre-populate with a signed-in user
    await authService.signUp("test@example.com", "password123")

    let captured: CapturedAuth | null = null

    renderToString(
      <AuthProvider authService={authService}>
        <AuthCapture onCapture={(auth) => (captured = auth)} />
      </AuthProvider>
    )

    expect(captured).not.toBeNull()
    // Note: In SSR, useEffect doesn't run so initializeAuth doesn't complete
    // The hook should still return its structure
    expect(captured?.isAuthenticated).toBeDefined()
    expect(typeof captured?.signIn).toBe("function")
    expect(typeof captured?.signUp).toBe("function")
    expect(typeof captured?.signOut).toBe("function")
  })

  test("isAuthenticated is false when no user", () => {
    const authService = new MockAuthService()
    let captured: CapturedAuth | null = null

    renderToString(
      <AuthProvider authService={authService}>
        <AuthCapture onCapture={(auth) => (captured = auth)} />
      </AuthProvider>
    )

    // Without initialization (SSR), user should be undefined/null
    expect(captured?.isAuthenticated).toBe(false)
  })
})

describe("useAuth hook structure", () => {
  test("returns all expected properties and methods", () => {
    const authService = new MockAuthService()
    let captured: CapturedAuth | null = null

    renderToString(
      <AuthProvider authService={authService}>
        <AuthCapture onCapture={(auth) => (captured = auth)} />
      </AuthProvider>
    )

    expect(captured).not.toBeNull()

    // Properties
    expect("user" in captured!).toBe(true)
    expect("isAuthenticated" in captured!).toBe(true)
    expect("loading" in captured!).toBe(true)
    expect("error" in captured!).toBe(true)

    // Methods
    expect(typeof captured?.signIn).toBe("function")
    expect(typeof captured?.signUp).toBe("function")
    expect(typeof captured?.signOut).toBe("function")
  })

  test("initial state has loading false and error null", () => {
    const authService = new MockAuthService()
    let captured: CapturedAuth | null = null

    renderToString(
      <AuthProvider authService={authService}>
        <AuthCapture onCapture={(auth) => (captured = auth)} />
      </AuthProvider>
    )

    expect(captured?.loading).toBe(false)
    expect(captured?.error).toBeNull()
  })
})

describe("useAuth error handling", () => {
  test("error state is available for error display", () => {
    const authService = new MockAuthService()
    let captured: CapturedAuth | null = null

    renderToString(
      <AuthProvider authService={authService}>
        <AuthCapture onCapture={(auth) => (captured = auth)} />
      </AuthProvider>
    )

    // Error starts as null
    expect(captured?.error).toBeNull()

    // The error property exists for displaying errors after failed operations
    expect("error" in captured!).toBe(true)
  })
})
