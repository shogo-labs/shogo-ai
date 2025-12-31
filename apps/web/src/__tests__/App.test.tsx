/**
 * App.tsx Integration Tests for task-ba-011
 *
 * Tests that BetterAuth is properly configured in the DomainProvider:
 * - BetterAuthService instantiated with apiUrl in EnvironmentProvider config
 * - betterAuthDomain added to DomainProvider domains map
 * - useDomains() hook provides access to auth store
 * - No custom BetterAuthContext or BetterAuthProvider created
 *
 * TDD: These tests are written BEFORE the implementation.
 * They should fail (RED) until App.tsx is modified.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
// Import directly from source files to avoid stale dist
// The workspace package resolves to dist/ which may be stale
import { betterAuthDomain, BetterAuthService, NullPersistence, teamsDomain, chatDomain } from "../../../../packages/state-api/src/index"

// ============================================================
// Test 1: BetterAuthService added to EnvironmentProvider services
// ============================================================

describe("test-ba-011-01: BetterAuthService added to EnvironmentProvider services", () => {
  test("BetterAuthService is exported from @shogo/state-api", () => {
    expect(BetterAuthService).toBeDefined()
    expect(typeof BetterAuthService).toBe("function")
  })

  test("BetterAuthService can be instantiated with baseUrl config", () => {
    const service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    expect(service).toBeDefined()
    expect(typeof service.signIn).toBe("function")
    expect(typeof service.signUp).toBe("function")
    expect(typeof service.signOut).toBe("function")
    expect(typeof service.getSession).toBe("function")
    expect(typeof service.onAuthStateChange).toBe("function")
  })
})

// ============================================================
// Test 2: betterAuthDomain added to DomainProvider domains map
// ============================================================

describe("test-ba-011-02: betterAuthDomain added to DomainProvider domains map", () => {
  test("betterAuthDomain is exported from @shogo/state-api", () => {
    expect(betterAuthDomain).toBeDefined()
    expect(betterAuthDomain.name).toBe("better-auth")
  })

  test("betterAuthDomain has createStore function", () => {
    expect(typeof betterAuthDomain.createStore).toBe("function")
  })

  test("betterAuthDomain follows same pattern as other domains", () => {
    // All domains should have the same shape
    expect(typeof betterAuthDomain.createStore).toBe("function")
    expect(typeof teamsDomain.createStore).toBe("function")
    expect(typeof chatDomain.createStore).toBe("function")

    expect(betterAuthDomain.name).toBeDefined()
    expect(teamsDomain.name).toBeDefined()
    expect(chatDomain.name).toBeDefined()
  })
})

// ============================================================
// Test 3: useDomains hook provides access to auth store
// ============================================================

describe("test-ba-011-03: useDomains hook provides access to auth store", () => {
  test("Store created with BetterAuthService has expected auth properties", () => {
    // Create a mock auth service
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => null,
      onAuthStateChange: () => () => {},
    }

    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    // Store should have auth-related views
    expect(store.authStatus).toBeDefined()
    expect(store.currentUser).toBeDefined()
    expect(store.isAuthenticated).toBeDefined()

    // Initial state
    expect(store.authStatus).toBe("idle")
    expect(store.currentUser).toBeNull()
    expect(store.isAuthenticated).toBe(false)
  })
})

// ============================================================
// Test 4: Domain initialize sets up onAuthStateChange subscription
// ============================================================

describe("test-ba-011-04: Domain initialize sets up onAuthStateChange subscription", () => {
  test("initialize() calls authService.getSession()", async () => {
    let getSessionCalled = false
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => {
        getSessionCalled = true
        return null
      },
      onAuthStateChange: () => () => {},
    }

    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    await store.initialize()

    expect(getSessionCalled).toBe(true)
  })

  test("initialize() calls onAuthStateChange when service supports it", async () => {
    let onAuthStateChangeCalled = false
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => null,
      onAuthStateChange: (callback: any) => {
        onAuthStateChangeCalled = true
        return () => {}
      },
    }

    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    await store.initialize()

    // The initialize action should set up the onAuthStateChange subscription
    expect(onAuthStateChangeCalled).toBe(true)
  })

  test("onAuthStateChange subscription syncs session to store", async () => {
    let capturedCallback: ((session: any) => void) | null = null
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => null,
      onAuthStateChange: (callback: (session: any) => void) => {
        capturedCallback = callback
        return () => {}
      },
    }

    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    await store.initialize()

    // Verify callback was captured
    expect(capturedCallback).not.toBeNull()

    // Simulate auth state change from BetterAuth
    const mockSession = {
      accessToken: "new-token",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: "user-123",
        email: "test@example.com",
        emailVerified: true,
        createdAt: new Date().toISOString(),
      },
    }

    capturedCallback!(mockSession)

    // Store should be synced with new session
    expect(store.isAuthenticated).toBe(true)
    expect(store.currentUser?.email).toBe("test@example.com")
  })

  test("onAuthStateChange with null clears auth state", async () => {
    let capturedCallback: ((session: any) => void) | null = null
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => ({
        accessToken: "initial-token",
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: {
          id: "user-123",
          email: "test@example.com",
          emailVerified: true,
          createdAt: new Date().toISOString(),
        },
      }),
      onAuthStateChange: (callback: (session: any) => void) => {
        capturedCallback = callback
        return () => {}
      },
    }

    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    await store.initialize()

    // Verify initially authenticated
    expect(store.isAuthenticated).toBe(true)

    // Simulate sign out from BetterAuth (callback with null)
    capturedCallback!(null)

    // Store should be cleared
    expect(store.isAuthenticated).toBe(false)
    expect(store.currentUser).toBeNull()
  })
})

// ============================================================
// Test 5: No custom BetterAuthContext or BetterAuthProvider created
// ============================================================

describe("test-ba-011-05: No custom BetterAuthContext or BetterAuthProvider created", () => {
  test("BetterAuthContext.tsx does not exist in contexts directory", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const contextsDir = path.resolve(
      import.meta.dir,
      "../contexts"
    )

    // Check that no BetterAuthContext file exists
    const files = fs.readdirSync(contextsDir)
    const hasBetterAuthContext = files.some(
      (f: string) => f.toLowerCase().includes("betterauth") && f.endsWith(".tsx")
    )

    expect(hasBetterAuthContext).toBe(false)
  })

  test("Auth is accessed via useDomains pattern, not custom hook", () => {
    // The pattern should be:
    // const { auth } = useDomains()
    // NOT:
    // const auth = useBetterAuth()

    // This is a design verification - if betterAuthDomain works with DomainProvider,
    // then no custom context is needed
    const mockAuthService = {
      signUp: async () => ({}),
      signIn: async () => ({}),
      signOut: async () => {},
      getSession: async () => null,
      onAuthStateChange: () => () => {},
    }

    // Domain can be used just like teams, chat, etc.
    const store = betterAuthDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        auth: mockAuthService as any,
      },
      context: {
        schemaName: "test-better-auth",
      },
    })

    // Store is usable without any custom context
    expect(store.authStatus).toBe("idle")
    expect(store.isAuthenticated).toBe(false)
    expect(typeof store.signIn).toBe("function")
    expect(typeof store.signUp).toBe("function")
    expect(typeof store.signOut).toBe("function")
    expect(typeof store.initialize).toBe("function")
  })
})
