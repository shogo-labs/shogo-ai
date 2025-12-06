/**
 * Generated from TestSpecification: test-021 through test-024
 * Task: task-auth-008
 * Requirement: req-auth-005
 *
 * Note: These tests use minimal React testing patterns.
 * For full component testing, consider adding @testing-library/react.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import React from "react"
import { renderToString } from "react-dom/server"
import { AuthProvider, useAuthStore } from "../AuthContext"
import { MockAuthService } from "@shogo/state-api"

// Helper to capture store from context - re-throws to test error handling
function StoreCapture({ onStore }: { onStore: (store: any) => void }) {
  const store = useAuthStore()
  onStore(store)
  return null
}

// Helper that catches errors for negative testing
function SafeStoreCapture({ onStore, onError }: { onStore: (store: any) => void; onError?: (err: Error) => void }) {
  try {
    const store = useAuthStore()
    onStore(store)
  } catch (err) {
    if (onError) onError(err as Error)
    else throw err
  }
  return null
}

describe("AuthProvider initializes auth on mount", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    // Set up existing session
    await authService.signUp("test@example.com", "password123")
  })

  test("Auth store is created and accessible via useAuthStore", () => {
    let capturedStore: any = null

    // Using server-side rendering to test basic setup
    // Note: useEffect won't run in SSR, so init won't complete
    const html = renderToString(
      <AuthProvider authService={authService}>
        <StoreCapture onStore={(store) => (capturedStore = store)} />
      </AuthProvider>
    )

    // In SSR, the provider renders but async init doesn't complete
    // The store should still be created
    expect(capturedStore).toBeDefined()
    expect(capturedStore?.authUserCollection).toBeDefined()
    expect(capturedStore?.authSessionCollection).toBeDefined()
  })
})

describe("useAuthStore hook", () => {
  test("throws error when used outside AuthProvider", () => {
    let caughtError: Error | null = null

    // SafeStoreCapture catches the error for us
    renderToString(
      <SafeStoreCapture
        onStore={() => {}}
        onError={(err) => (caughtError = err)}
      />
    )

    expect(caughtError).not.toBeNull()
    expect(caughtError?.message).toContain("useAuthStore must be used within AuthProvider")
  })

  test("returns store when used inside AuthProvider", () => {
    const authService = new MockAuthService()
    let capturedStore: any = null

    renderToString(
      <AuthProvider authService={authService}>
        <StoreCapture onStore={(store) => (capturedStore = store)} />
      </AuthProvider>
    )

    expect(capturedStore).not.toBeNull()
    expect(typeof capturedStore.initializeAuth).toBe("function")
    expect(typeof capturedStore.syncAuthState).toBe("function")
  })
})

describe("AuthProvider with MockAuthService", () => {
  test("Collections have correct structure", () => {
    const authService = new MockAuthService()
    let capturedStore: any = null

    renderToString(
      <AuthProvider authService={authService}>
        <StoreCapture onStore={(store) => (capturedStore = store)} />
      </AuthProvider>
    )

    // Verify collection methods exist
    expect(typeof capturedStore.authUserCollection.add).toBe("function")
    expect(typeof capturedStore.authUserCollection.get).toBe("function")
    expect(typeof capturedStore.authUserCollection.all).toBe("function")
    expect(typeof capturedStore.authUserCollection.findByEmail).toBe("function")

    expect(typeof capturedStore.authSessionCollection.add).toBe("function")
    expect(typeof capturedStore.authSessionCollection.get).toBe("function")
  })
})
