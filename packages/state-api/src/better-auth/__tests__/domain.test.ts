/**
 * Generated from TestSpecifications for task-ba-003
 * Task: task-ba-003 (Create BetterAuth domain)
 * Requirement: req-ba-001
 *
 * TDD: These tests are written BEFORE the implementation.
 * They should fail (RED) until domain.ts is created.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { BetterAuthSchema } from "../schema"
import { betterAuthDomain, createBetterAuthStore } from "../domain"
import { NullPersistence } from "../../persistence/null"
import type { IEnvironment } from "../../environment/types"
import type { AuthCredentials, AuthSession } from "../../auth/types"

// ============================================================
// Mock BetterAuth Service for Testing
// ============================================================

class MockBetterAuthService {
  private users: Map<string, any> = new Map()
  private sessions: Map<string, any> = new Map()
  private currentSession: AuthSession | null = null
  private delay: number

  constructor(options?: { delay?: number }) {
    this.delay = options?.delay ?? 0
  }

  private async wait() {
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay))
    }
  }

  async signUp(credentials: AuthCredentials): Promise<AuthSession> {
    await this.wait()

    const userId = crypto.randomUUID()
    const user = {
      id: userId,
      email: credentials.email,
      name: credentials.email.split("@")[0],
      image: null,
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.users.set(userId, user)

    const session: AuthSession = {
      accessToken: `token-${crypto.randomUUID()}`,
      refreshToken: `refresh-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: userId,
        email: credentials.email,
        emailVerified: false,
        createdAt: user.createdAt,
      },
    }

    this.currentSession = session
    this.sessions.set(userId, session)

    return session
  }

  async signIn(credentials: AuthCredentials): Promise<AuthSession> {
    await this.wait()

    // Find user by email
    let foundUser: any = null
    for (const user of this.users.values()) {
      if (user.email === credentials.email) {
        foundUser = user
        break
      }
    }

    if (!foundUser) {
      throw new Error("Invalid credentials")
    }

    const session: AuthSession = {
      accessToken: `token-${crypto.randomUUID()}`,
      refreshToken: `refresh-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: foundUser.id,
        email: foundUser.email,
        emailVerified: foundUser.emailVerified,
        createdAt: foundUser.createdAt,
      },
    }

    this.currentSession = session
    this.sessions.set(foundUser.id, session)

    return session
  }

  async signOut(): Promise<void> {
    await this.wait()
    this.currentSession = null
  }

  async getSession(): Promise<AuthSession | null> {
    await this.wait()
    return this.currentSession
  }

  onAuthStateChange(_callback: (session: AuthSession | null) => void): () => void {
    return () => {}
  }

  // BetterAuth-specific methods
  signInWithGoogle(): Promise<void> {
    return Promise.resolve()
  }

  getGoogleSignInUrl(): string {
    return "https://accounts.google.com/oauth"
  }
}

// Helper to create a test environment
function createTestEnv(mockAuth?: MockBetterAuthService): IEnvironment {
  return {
    services: {
      persistence: new NullPersistence(),
      auth: mockAuth ?? new MockBetterAuthService(),
      backendRegistry: {
        register: () => {},
        get: () => undefined,
        has: () => false,
        resolve: () => {
          throw new Error("No backend configured")
        },
        setDefault: () => {},
      } as any,
    },
    context: {
      schemaName: "test-better-auth",
    },
  }
}

// ============================================================
// 1. betterAuthDomain uses domain() with BetterAuthSchema
// ============================================================

describe("betterAuthDomain uses domain() with BetterAuthSchema", () => {
  test("betterAuthDomain is defined and has name 'better-auth'", () => {
    expect(betterAuthDomain).toBeDefined()
    expect(betterAuthDomain.name).toBe("better-auth")
  })

  test("betterAuthDomain has enhancedSchema derived from BetterAuthSchema", () => {
    expect(betterAuthDomain.enhancedSchema).toBeDefined()
    expect(betterAuthDomain.enhancedSchema.$defs).toBeDefined()
    expect(betterAuthDomain.enhancedSchema.$defs!.User).toBeDefined()
    expect(betterAuthDomain.enhancedSchema.$defs!.Session).toBeDefined()
    expect(betterAuthDomain.enhancedSchema.$defs!.Account).toBeDefined()
    expect(betterAuthDomain.enhancedSchema.$defs!.Verification).toBeDefined()
  })

  test("betterAuthDomain has createStore function", () => {
    expect(typeof betterAuthDomain.createStore).toBe("function")
  })

  test("betterAuthDomain has RootStoreModel", () => {
    expect(betterAuthDomain.RootStoreModel).toBeDefined()
  })
})

// ============================================================
// 2. Store has all collections from BetterAuthSchema
// ============================================================

describe("createBetterAuthStore creates store with collections", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("Store has userCollection", () => {
    expect(store.userCollection).toBeDefined()
    expect(typeof store.userCollection.add).toBe("function")
  })

  test("Store has sessionCollection", () => {
    expect(store.sessionCollection).toBeDefined()
    expect(typeof store.sessionCollection.add).toBe("function")
  })

  test("Store has accountCollection", () => {
    expect(store.accountCollection).toBeDefined()
    expect(typeof store.accountCollection.add).toBe("function")
  })

  test("Store has verificationCollection", () => {
    expect(store.verificationCollection).toBeDefined()
    expect(typeof store.verificationCollection.add).toBe("function")
  })

  test("Collections are initially empty", () => {
    expect(store.userCollection.all()).toHaveLength(0)
    expect(store.sessionCollection.all()).toHaveLength(0)
    expect(store.accountCollection.all()).toHaveLength(0)
    expect(store.verificationCollection.all()).toHaveLength(0)
  })
})

// ============================================================
// 3. Session.isExpired computed view
// ============================================================

describe("Session.isExpired computed view works correctly", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("Returns true for expired session", () => {
    // Add user first
    const user = store.userCollection.add({
      id: "user-001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    // Add session with past expiresAt
    const session = store.sessionCollection.add({
      id: "session-001",
      userId: user.id,
      token: "token-123",
      expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      ipAddress: "192.168.1.1",
      userAgent: "Test Agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    expect(session.isExpired).toBe(true)
  })

  test("Returns false for valid session", () => {
    const user = store.userCollection.add({
      id: "user-001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const session = store.sessionCollection.add({
      id: "session-001",
      userId: user.id,
      token: "token-123",
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      ipAddress: "192.168.1.1",
      userAgent: "Test Agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    expect(session.isExpired).toBe(false)
  })
})

// ============================================================
// 4. RootStore volatile authStatus and authError
// ============================================================

describe("Store has volatile authStatus and authError", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("authStatus is initially 'idle'", () => {
    expect(store.authStatus).toBe("idle")
  })

  test("authError is initially null", () => {
    expect(store.authError).toBeNull()
  })

  test("authStatus can be observed for changes", () => {
    expect(typeof store.authStatus).toBe("string")
  })
})

// ============================================================
// 5. RootStore views: currentUser, currentSession, isAuthenticated
// ============================================================

describe("RootStore views work correctly", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockAuth = new MockBetterAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("currentUser returns null when no user exists", () => {
    expect(store.currentUser).toBeNull()
  })

  test("currentSession returns null when no session exists", () => {
    expect(store.currentSession).toBeNull()
  })

  test("isAuthenticated returns false when no session exists", () => {
    expect(store.isAuthenticated).toBe(false)
  })

  test("isAuthenticated returns true after successful signIn", async () => {
    // Sign up first to create user
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })

    // Now sync via the store's signIn action
    await store.signIn({ email: "test@example.com", password: "secret123" })

    expect(store.isAuthenticated).toBe(true)
  })

  test("currentUser returns the user after signIn", async () => {
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })
    await store.signIn({ email: "test@example.com", password: "secret123" })

    expect(store.currentUser).toBeDefined()
    expect(store.currentUser.email).toBe("test@example.com")
  })

  test("currentSession returns the session after signIn", async () => {
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })
    await store.signIn({ email: "test@example.com", password: "secret123" })

    expect(store.currentSession).toBeDefined()
    expect(store.currentSession.token).toBeDefined()
  })
})

// ============================================================
// 6. RootStore actions: syncFromSession
// ============================================================

describe("syncFromSession action syncs auth state", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("Populates userCollection with user data", () => {
    const session: AuthSession = {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: "user-123",
        email: "test@example.com",
        emailVerified: true,
        createdAt: new Date().toISOString(),
      },
    }

    store.syncFromSession(session)

    const users = store.userCollection.all()
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe("test@example.com")
  })

  test("Populates sessionCollection with session data", () => {
    const session: AuthSession = {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: "user-123",
        email: "test@example.com",
        emailVerified: true,
        createdAt: new Date().toISOString(),
      },
    }

    store.syncFromSession(session)

    const sessions = store.sessionCollection.all()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].token).toBe("test-token")
  })

  test("Clears existing data before syncing", () => {
    // Add some initial data
    store.userCollection.add({
      id: "old-user",
      name: "Old User",
      email: "old@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const session: AuthSession = {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: "new-user",
        email: "new@example.com",
        emailVerified: true,
        createdAt: new Date().toISOString(),
      },
    }

    store.syncFromSession(session)

    const users = store.userCollection.all()
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe("new@example.com")
  })
})

// ============================================================
// 7. RootStore actions: clearAuthState
// ============================================================

describe("clearAuthState action clears all auth state", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockBetterAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)

    // Sign up to create initial state
    await store.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("Clears userCollection", () => {
    store.clearAuthState()
    expect(store.userCollection.all()).toHaveLength(0)
  })

  test("Clears sessionCollection", () => {
    store.clearAuthState()
    expect(store.sessionCollection.all()).toHaveLength(0)
  })

  test("Resets authStatus to 'idle'", () => {
    store.clearAuthState()
    expect(store.authStatus).toBe("idle")
  })

  test("Resets authError to null", () => {
    store.clearAuthState()
    expect(store.authError).toBeNull()
  })

  test("isAuthenticated returns false after clear", () => {
    store.clearAuthState()
    expect(store.isAuthenticated).toBe(false)
  })
})

// ============================================================
// 8. RootStore actions: signUp
// ============================================================

describe("signUp action coordinates with auth service", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockAuth = new MockBetterAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("authStatus changes to 'loading' during operation", async () => {
    const delayedMock = new MockBetterAuthService({ delay: 50 })
    const delayedEnv = createTestEnv(delayedMock)
    const { createStore } = createBetterAuthStore()
    const delayedStore = createStore(delayedEnv)

    const signUpPromise = delayedStore.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    expect(delayedStore.authStatus).toBe("loading")

    await signUpPromise
  })

  test("User entity is added to userCollection", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    const users = store.userCollection.all()
    expect(users).toHaveLength(1)
    expect(users[0].email).toBe("test@example.com")
  })

  test("Session entity is added to sessionCollection", async () => {
    await store.signUp({ email: "test@example.com", password: "secret123" })

    const sessions = store.sessionCollection.all()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].token).toBeDefined()
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

// ============================================================
// 9. RootStore actions: signIn with errors
// ============================================================

describe("signIn action handles errors correctly", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockAuth = new MockBetterAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("authStatus changes to 'error' on invalid credentials", async () => {
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

    expect(store.userCollection.all()).toHaveLength(0)
    expect(store.sessionCollection.all()).toHaveLength(0)
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

// ============================================================
// 10. RootStore actions: signOut
// ============================================================

describe("signOut action clears all auth state", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockBetterAuthService()
    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)

    // Sign up to create initial state
    await store.signUp({ email: "test@example.com", password: "secret123" })
  })

  test("Auth service signOut is called", async () => {
    await store.signOut()

    // Verify mock session is cleared
    const mockSession = await mockAuth.getSession()
    expect(mockSession).toBeNull()
  })

  test("userCollection is cleared", async () => {
    await store.signOut()

    expect(store.userCollection.all()).toHaveLength(0)
  })

  test("sessionCollection is cleared", async () => {
    await store.signOut()

    expect(store.sessionCollection.all()).toHaveLength(0)
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

// ============================================================
// 11. RootStore actions: initialize
// ============================================================

describe("initialize action restores session on startup", () => {
  let mockAuth: MockBetterAuthService
  let env: IEnvironment
  let store: any

  beforeEach(async () => {
    mockAuth = new MockBetterAuthService()
    // First, create a session in the mock
    await mockAuth.signUp({ email: "test@example.com", password: "secret123" })

    env = createTestEnv(mockAuth)
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("Auth service getSession is called", async () => {
    await store.initialize()

    // The store should have loaded the session from the mock
    expect(store.isAuthenticated).toBe(true)
  })

  test("If session exists, User and Session are populated", async () => {
    await store.initialize()

    expect(store.userCollection.all()).toHaveLength(1)
    expect(store.sessionCollection.all()).toHaveLength(1)
  })

  test("isAuthenticated reflects restored state", async () => {
    await store.initialize()

    expect(store.isAuthenticated).toBe(true)
    expect(store.currentUser?.email).toBe("test@example.com")
  })
})

// ============================================================
// 12. Session.userId reference resolves to User instance
// ============================================================

describe("Session.userId reference resolves to User instance", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("session.userId resolves to User instance", () => {
    const user = store.userCollection.add({
      id: "user-001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const session = store.sessionCollection.add({
      id: "session-001",
      userId: user.id,
      token: "token-123",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ipAddress: "192.168.1.1",
      userAgent: "Test Agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    // CRITICAL: Instance equality proves MST reference works
    expect(session.userId).toBe(user)
    expect(session.userId?.email).toBe("test@example.com")
  })
})

// ============================================================
// 13. Account.userId reference resolves to User instance
// ============================================================

describe("Account.userId reference resolves to User instance", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createBetterAuthStore()
    store = createStore(env)
  })

  test("account.userId resolves to User instance", () => {
    const user = store.userCollection.add({
      id: "user-001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const account = store.accountCollection.add({
      id: "account-001",
      userId: user.id,
      accountId: "google-123",
      providerId: "google",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    // CRITICAL: Instance equality proves MST reference works
    expect(account.userId).toBe(user)
    expect(account.userId?.email).toBe("test@example.com")
  })
})

// ============================================================
// 14. createBetterAuthStore factory function export
// ============================================================

describe("createBetterAuthStore factory function", () => {
  test("createBetterAuthStore is exported", () => {
    expect(createBetterAuthStore).toBeDefined()
    expect(typeof createBetterAuthStore).toBe("function")
  })

  test("Returns object with createStore method", () => {
    const result = createBetterAuthStore()
    expect(result.createStore).toBeDefined()
    expect(typeof result.createStore).toBe("function")
  })

  test("Returns object with RootStoreModel", () => {
    const result = createBetterAuthStore()
    expect(result.RootStoreModel).toBeDefined()
  })

  test("Returns object with domain reference", () => {
    const result = createBetterAuthStore()
    expect(result.domain).toBeDefined()
    expect(result.domain.name).toBe("better-auth")
  })
})
