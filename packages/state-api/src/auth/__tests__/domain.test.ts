/**
 * Generated from TestSpecification: test-012 through test-020
 * Task: task-auth-005
 * Requirement: req-auth-004, req-auth-005
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { scope } from "arktype"
import { createAuthStore, AuthDomain } from "../domain"
import { MockAuthService } from "../mock"
import { NullPersistence } from "../../persistence/null"
import type { IEnvironment } from "../../environment/types"

describe("AuthDomain scope defines correct entities", () => {
  test("AuthUser entity has id, email, createdAt fields", () => {
    // Access the scope to verify structure
    const userType = AuthDomain.type("AuthUser")
    expect(userType).toBeDefined()

    // Validate a user object - ArkType returns validated data directly on success
    const result = userType({
      id: "user-123",
      email: "test@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })
    // If validation passes, result is the validated object
    // If validation fails, result has errors
    const hasErrors = (result as any)[" arkKind"] === "errors"
    expect(hasErrors).toBe(false)
  })

  test("AuthSession entity has id, user reference, lastRefreshedAt fields", () => {
    const sessionType = AuthDomain.type("AuthSession")
    expect(sessionType).toBeDefined()

    // Session with user object (ArkType validates against the type definition)
    const result = sessionType({
      id: "session-123",
      user: { id: "user-123", email: "test@example.com", createdAt: "2024-01-01T00:00:00Z" },
      lastRefreshedAt: "2024-01-01T12:00:00Z"
    })
    const hasErrors = (result as any)[" arkKind"] === "errors"
    expect(hasErrors).toBe(false)
  })

  test("AuthSession allows undefined user (optional field)", () => {
    const sessionType = AuthDomain.type("AuthSession")

    // Session without user (unauthenticated state) - user is optional
    const result = sessionType({
      id: "session-123",
      lastRefreshedAt: "2024-01-01T12:00:00Z"
    })
    const hasErrors = (result as any)[" arkKind"] === "errors"
    expect(hasErrors).toBe(false)
  })
})

describe("createAuthStore factory creates valid MST store", () => {
  let env: IEnvironment
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
    env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService
      },
      context: {
        schemaName: "auth-test"
      }
    }
  })

  test("Returns store with authUserCollection", () => {
    const store = createAuthStore(env)
    expect(store.authUserCollection).toBeDefined()
  })

  test("Returns store with authSessionCollection", () => {
    const store = createAuthStore(env)
    expect(store.authSessionCollection).toBeDefined()
  })

  test("Collections have add, get, remove actions", () => {
    const store = createAuthStore(env)

    expect(typeof store.authUserCollection.add).toBe("function")
    expect(typeof store.authUserCollection.get).toBe("function")
    expect(typeof store.authUserCollection.remove).toBe("function")
  })
})

describe("AuthSession.isAuthenticated computed view", () => {
  let env: IEnvironment
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
    env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService
      },
      context: {
        schemaName: "auth-test"
      }
    }
  })

  test("returns true when user reference is set", () => {
    const store = createAuthStore(env)

    // Add a user first (must exist before referencing)
    store.authUserCollection.add({
      id: "user-123",
      email: "test@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })

    // Add session with user reference (using string ID for MST reference)
    const session = store.authSessionCollection.add({
      id: "current",
      user: "user-123",
      lastRefreshedAt: new Date().toISOString()
    })

    expect(session.isAuthenticated).toBe(true)
  })

  test("returns false when user is undefined (not set)", () => {
    const store = createAuthStore(env)

    // Add session without user (omit user field for undefined)
    const session = store.authSessionCollection.add({
      id: "current",
      lastRefreshedAt: new Date().toISOString()
    })

    expect(session.isAuthenticated).toBe(false)
  })
})

describe("authUserCollection.findByEmail query method", () => {
  let env: IEnvironment
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
    env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService
      },
      context: {
        schemaName: "auth-test"
      }
    }
  })

  test("returns matching user", () => {
    const store = createAuthStore(env)

    store.authUserCollection.add({
      id: "user-1",
      email: "alice@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })
    store.authUserCollection.add({
      id: "user-2",
      email: "bob@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })

    const found = store.authUserCollection.findByEmail("alice@example.com")
    expect(found).toBeDefined()
    expect(found?.id).toBe("user-1")
  })

  test("returns undefined for non-existent email", () => {
    const store = createAuthStore(env)

    store.authUserCollection.add({
      id: "user-1",
      email: "alice@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })

    const found = store.authUserCollection.findByEmail("nonexistent@example.com")
    expect(found).toBeUndefined()
  })
})

describe("initializeAuth action", () => {
  let env: IEnvironment
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
    env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService
      },
      context: {
        schemaName: "auth-test"
      }
    }
  })

  test("restores session from service when session exists", async () => {
    // Set up existing session in mock service
    await authService.signUp("test@example.com", "password123")

    const store = createAuthStore(env)

    // Initialize auth should restore the session
    await store.initializeAuth()

    // Verify user was added
    const user = store.authUserCollection.findByEmail("test@example.com")
    expect(user).toBeDefined()

    // Verify session was created
    const session = store.authSessionCollection.get("current")
    expect(session).toBeDefined()
    expect(session?.user).toBe(user)
  })

  test("handles no existing session gracefully", async () => {
    const store = createAuthStore(env)

    // No session in service, should not throw
    await expect(store.initializeAuth()).resolves.toBeUndefined()

    // Session should exist but with undefined user
    const session = store.authSessionCollection.get("current")
    expect(session?.user).toBeUndefined()
  })
})

describe("syncAuthState action", () => {
  let env: IEnvironment
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
    env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService
      },
      context: {
        schemaName: "auth-test"
      }
    }
  })

  test("updates store from auth event with new user data", () => {
    const store = createAuthStore(env)

    // Ensure session entity exists (omit user for undefined)
    store.authSessionCollection.add({
      id: "current",
      lastRefreshedAt: new Date().toISOString()
    })

    // Sync new user state
    store.syncAuthState({
      user: {
        id: "user-new",
        email: "new@example.com",
        createdAt: "2024-01-01T00:00:00Z"
      },
      lastRefreshedAt: new Date().toISOString()
    })

    // User should be added
    const user = store.authUserCollection.get("user-new")
    expect(user).toBeDefined()
    expect(user?.email).toBe("new@example.com")

    // Session should reference the user
    const session = store.authSessionCollection.get("current")
    expect(session?.user).toBe(user)
  })

  test("clears user on sign out event (null session)", () => {
    const store = createAuthStore(env)

    // Set up authenticated state
    store.authUserCollection.add({
      id: "user-123",
      email: "test@example.com",
      createdAt: "2024-01-01T00:00:00Z"
    })
    store.authSessionCollection.add({
      id: "current",
      user: "user-123",
      lastRefreshedAt: new Date().toISOString()
    })

    // Verify initial state
    expect(store.authSessionCollection.get("current")?.isAuthenticated).toBe(true)

    // Sync null state (sign out)
    store.syncAuthState(null)

    // Session user should be undefined (cleared)
    const session = store.authSessionCollection.get("current")
    expect(session?.user).toBeUndefined()
    expect(session?.isAuthenticated).toBe(false)
  })
})
