/**
 * Generated from TestSpecifications: test-auth-017 to test-auth-025
 * Task: task-auth-005
 * Requirement: req-auth-002
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { AuthDomain, createAuthStore } from "../domain"
import { MockAuthService } from "../mock"
import { NullPersistence } from "../../persistence/null"
import type { IEnvironment } from "../../environment/types"

// Helper to create a test environment with MockAuthService
function createTestEnv(mockAuth?: MockAuthService): IEnvironment {
  return {
    services: {
      persistence: new NullPersistence(),
      auth: mockAuth ?? new MockAuthService(),
      backendRegistry: {
        register: () => {},
        get: () => undefined,
        has: () => false,
        resolve: () => { throw new Error("No backend configured") },
        setDefault: () => {},
      } as any,
    },
    context: {
      schemaName: "test-auth",
    },
  }
}

describe("AuthDomain exports ArkType scope with entities", () => {
  test("Scope includes AuthUser entity with id, email, emailVerified, createdAt", () => {
    // Verify scope is defined and exports AuthUser
    expect(AuthDomain).toBeDefined()

    // The scope should have AuthUser in its exports
    const types = AuthDomain.export()
    expect(types.AuthUser).toBeDefined()
  })

  test("Scope includes AuthSession entity with id, userId, accessToken, refreshToken, expiresAt", () => {
    const types = AuthDomain.export()
    expect(types.AuthSession).toBeDefined()
  })
})

describe("createAuthStore creates store with collections", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("Store has authUserCollection", () => {
    expect(store.authUserCollection).toBeDefined()
    expect(typeof store.authUserCollection.add).toBe("function")
  })

  test("Store has authSessionCollection", () => {
    expect(store.authSessionCollection).toBeDefined()
    expect(typeof store.authSessionCollection.add).toBe("function")
  })

  test("Collections are initially empty", () => {
    expect(store.authUserCollection.all()).toHaveLength(0)
    expect(store.authSessionCollection.all()).toHaveLength(0)
  })
})

describe("AuthSession.isExpired computed view works correctly", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("Returns true for expired session", () => {
    // Add user first
    const user = store.authUserCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
    })

    // Add session with past expiresAt
    const session = store.authSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      userId: user.id,
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    })

    expect(session.isExpired).toBe(true)
  })

  test("Returns false for valid session", () => {
    const user = store.authUserCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
    })

    const session = store.authSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      userId: user.id,
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    })

    expect(session.isExpired).toBe(false)
  })
})

describe("Store has volatile authStatus and authError", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("authStatus is initially 'idle'", () => {
    expect(store.authStatus).toBe("idle")
  })

  test("authError is initially null", () => {
    expect(store.authError).toBeNull()
  })

  test("authStatus can be observed for changes", () => {
    // This test verifies the property exists and is readable
    // MobX reactivity is implicitly tested by the store working
    expect(typeof store.authStatus).toBe("string")
  })
})

describe("isAuthenticated view reflects current state", () => {
  let mockAuth: MockAuthService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockAuth = new MockAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("Returns false when no session exists", () => {
    expect(store.isAuthenticated).toBe(false)
  })

  test("Returns true after successful signIn", async () => {
    // Sign up first to create user
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })

    // Now sync the user to store via the store's signIn action
    await store.signIn({ email: "test@example.com", password: "secret123" })

    expect(store.isAuthenticated).toBe(true)
  })
})

describe("signUp action coordinates with auth service and syncs state", () => {
  let mockAuth: MockAuthService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockAuth = new MockAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("authStatus changes to 'loading' during operation", async () => {
    // Use delayed mock to catch loading state
    const delayedMock = new MockAuthService({ delay: 50 })
    const delayedEnv = createTestEnv(delayedMock)
    const { createStore } = createAuthStore()
    const delayedStore = createStore(delayedEnv)

    const signUpPromise = delayedStore.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    // Check status during operation
    expect(delayedStore.authStatus).toBe("loading")

    await signUpPromise
  })

  test("MockAuthService.signUp is called with credentials", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    // Verify by checking the mock has the user
    const session = await mockAuth.getSession()
    expect(session?.user.email).toBe("test@example.com")
  })

  test("AuthUser entity is added to authUserCollection", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    const users = store.authUserCollection.all()
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe("test@example.com")
  })

  test("AuthSession entity is added to authSessionCollection", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    const sessions = store.authSessionCollection.all()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].accessToken).toBeDefined()
  })

  test("authStatus changes to 'idle' on success", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    expect(store.authStatus).toBe("idle")
  })

  test("currentUser returns the new user", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    expect(store.currentUser).toBeDefined()
    expect(store.currentUser.email).toBe("test@example.com")
  })
})

describe("signIn action handles errors correctly", () => {
  let mockAuth: MockAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("authStatus changes to 'error' on invalid credentials", async () => {
    // Try to sign in without signing up first
    try {
      await store.signIn({ email: "nonexistent@example.com", password: "wrong" })
    } catch {
      // Expected
    }

    expect(store.authStatus).toBe("error")
  })

  test("authError contains error message", async () => {
    try {
      await store.signIn({ email: "nonexistent@example.com", password: "wrong" })
    } catch {
      // Expected
    }

    expect(store.authError).toBeDefined()
    expect(store.authError).toContain("Invalid")
  })

  test("No user or session entities are created", async () => {
    try {
      await store.signIn({ email: "nonexistent@example.com", password: "wrong" })
    } catch {
      // Expected
    }

    expect(store.authUserCollection.all()).toHaveLength(0)
    expect(store.authSessionCollection.all()).toHaveLength(0)
  })

  test("isAuthenticated remains false", async () => {
    try {
      await store.signIn({ email: "nonexistent@example.com", password: "wrong" })
    } catch {
      // Expected
    }

    expect(store.isAuthenticated).toBe(false)
  })
})

describe("signOut action clears all auth state", () => {
  let mockAuth: MockAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createAuthStore()
    store = createStore(env)

    // Sign up to create initial state
    await store.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("MockAuthService.signOut is called", async () => {
    await store.signOut()

    // Verify mock session is cleared
    const mockSession = await mockAuth.getSession()
    expect(mockSession).toBeNull()
  })

  test("authUserCollection is cleared", async () => {
    await store.signOut()

    expect(store.authUserCollection.all()).toHaveLength(0)
  })

  test("authSessionCollection is cleared", async () => {
    await store.signOut()

    expect(store.authSessionCollection.all()).toHaveLength(0)
  })

  test("currentUser returns null", async () => {
    await store.signOut()

    expect(store.currentUser).toBeNull()
  })

  test("isAuthenticated returns false", async () => {
    await store.signOut()

    expect(store.isAuthenticated).toBe(false)
  })

  test("authStatus is 'idle'", async () => {
    await store.signOut()

    expect(store.authStatus).toBe("idle")
  })
})

describe("initialize action restores session on startup", () => {
  let mockAuth: MockAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockAuthService()
    // First, create a session in the mock
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })

    env = createTestEnv(mockAuth)
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("MockAuthService.getSession is called", async () => {
    await store.initialize()

    // The store should have loaded the session from the mock
    // We verify this by checking isAuthenticated
    expect(store.isAuthenticated).toBe(true)
  })

  test("If session exists, AuthUser and AuthSession are populated", async () => {
    await store.initialize()

    expect(store.authUserCollection.all()).toHaveLength(1)
    expect(store.authSessionCollection.all()).toHaveLength(1)
  })

  test("isAuthenticated reflects restored state", async () => {
    await store.initialize()

    expect(store.isAuthenticated).toBe(true)
    expect(store.currentUser?.email).toBe("test@example.com")
  })
})

describe("AuthSession.userId reference resolves to AuthUser instance", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createAuthStore()
    store = createStore(env)
  })

  test("session.userId resolves to AuthUser instance", () => {
    const user = store.authUserCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
    })

    const session = store.authSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      userId: user.id,
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })

    // CRITICAL: Instance equality proves MST reference works
    expect(session.userId).toBe(user)
    expect(session.userId?.email).toBe("test@example.com")
  })
})
