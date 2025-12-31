/**
 * Tests for BetterAuthService
 * Task: task-ba-004
 *
 * TDD: These tests are written BEFORE the implementation.
 * They should fail (RED) until service.ts is created.
 */

import { describe, test, expect, beforeEach, mock, spyOn, afterEach } from "bun:test"
import { BetterAuthService } from "../service"
import type { AuthError } from "../../auth/types"
import type { BetterAuthUser, BetterAuthSession } from "../types"

// Mock BetterAuth API response structures
const mockBetterAuthUser: BetterAuthUser = {
  id: "ba-user-123",
  email: "test@example.com",
  name: "Test User",
  image: "https://example.com/avatar.png",
  emailVerified: true,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

const mockBetterAuthSession: BetterAuthSession = {
  id: "ba-session-123",
  token: "ba-access-token-xyz",
  userId: "ba-user-123",
  expiresAt: "2024-01-01T01:00:00Z",
  ipAddress: "192.168.1.1",
  userAgent: "Mozilla/5.0",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

// BetterAuth API response format
const mockSessionResponse = {
  session: mockBetterAuthSession,
  user: mockBetterAuthUser,
}

describe("BetterAuthService constructor takes config", () => {
  test("Constructor accepts { baseUrl: string } config", () => {
    const service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    expect(service).toBeDefined()
  })

  test("getGoogleSignInUrl uses baseUrl from config", () => {
    const service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    const url = service.getGoogleSignInUrl()
    expect(url).toContain("http://localhost:3000")
  })
})

describe("BetterAuthService signUp calls POST /api/auth/sign-up/email", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSessionResponse),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Calls POST to /api/auth/sign-up/email endpoint", async () => {
    await service.signUp({ email: "test@example.com", password: "secret123" })

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/sign-up/email",
      expect.objectContaining({
        method: "POST",
      })
    )
  })

  test("Sends credentials:include for cookie handling", async () => {
    await service.signUp({ email: "test@example.com", password: "secret123" })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: "include",
      })
    )
  })

  test("Sends email and password in request body", async () => {
    await service.signUp({ email: "test@example.com", password: "secret123" })

    const callArgs = mockFetch.mock.calls[0]
    const options = callArgs[1] as RequestInit
    const body = JSON.parse(options.body as string)

    expect(body.email).toBe("test@example.com")
    expect(body.password).toBe("secret123")
  })

  test("Returns AuthSession mapped from BetterAuth response", async () => {
    const session = await service.signUp({ email: "test@example.com", password: "secret123" })

    expect(session.accessToken).toBe("ba-access-token-xyz")
    expect(session.user.id).toBe("ba-user-123")
    expect(session.user.email).toBe("test@example.com")
  })

  test("AuthUser contains mapped fields from BetterAuthUser", async () => {
    const session = await service.signUp({ email: "test@example.com", password: "secret123" })

    expect(session.user.id).toBe("ba-user-123")
    expect(session.user.email).toBe("test@example.com")
    expect(session.user.emailVerified).toBe(true)
    expect(session.user.createdAt).toBe("2024-01-01T00:00:00Z")
  })
})

describe("BetterAuthService signIn calls POST /api/auth/sign-in/email", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSessionResponse),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Calls POST to /api/auth/sign-in/email endpoint", async () => {
    await service.signIn({ email: "test@example.com", password: "secret123" })

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/sign-in/email",
      expect.objectContaining({
        method: "POST",
      })
    )
  })

  test("Sends credentials:include for cookie handling", async () => {
    await service.signIn({ email: "test@example.com", password: "secret123" })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: "include",
      })
    )
  })

  test("Sends email and password in request body", async () => {
    await service.signIn({ email: "test@example.com", password: "secret123" })

    const callArgs = mockFetch.mock.calls[0]
    const options = callArgs[1] as RequestInit
    const body = JSON.parse(options.body as string)

    expect(body.email).toBe("test@example.com")
    expect(body.password).toBe("secret123")
  })

  test("Returns AuthSession with accessToken from BetterAuth", async () => {
    const session = await service.signIn({ email: "test@example.com", password: "secret123" })

    expect(session.accessToken).toBe("ba-access-token-xyz")
  })
})

describe("BetterAuthService signOut calls POST /api/auth/sign-out", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Calls POST to /api/auth/sign-out endpoint", async () => {
    await service.signOut()

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/sign-out",
      expect.objectContaining({
        method: "POST",
      })
    )
  })

  test("Returns void on success", async () => {
    const result = await service.signOut()
    expect(result).toBeUndefined()
  })
})

describe("BetterAuthService getSession calls GET /api/auth/get-session", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSessionResponse),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Calls GET to /api/auth/get-session endpoint", async () => {
    await service.getSession()

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/get-session",
      expect.objectContaining({
        method: "GET",
      })
    )
  })

  test("Sends credentials:include for cookie handling", async () => {
    await service.getSession()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: "include",
      })
    )
  })

  test("Returns AuthSession when session exists", async () => {
    const session = await service.getSession()

    expect(session).not.toBeNull()
    expect(session?.accessToken).toBe("ba-access-token-xyz")
    expect(session?.user.id).toBe("ba-user-123")
  })

  test("Returns null when no session exists", async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ session: null, user: null }),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const session = await service.getSession()
    expect(session).toBeNull()
  })
})

describe("BetterAuthService converts errors to AuthError", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: "Invalid credentials" }),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Throws AuthError with code on failed signIn", async () => {
    try {
      await service.signIn({ email: "test@example.com", password: "wrong" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBeDefined()
      expect(typeof authError.code).toBe("string")
    }
  })

  test("AuthError message contains original error message", async () => {
    try {
      await service.signIn({ email: "test@example.com", password: "wrong" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.message).toContain("Invalid credentials")
    }
  })

  test("Maps 401 status to invalid_credentials code", async () => {
    try {
      await service.signIn({ email: "test@example.com", password: "wrong" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("invalid_credentials")
    }
  })

  test("Maps email_exists error for duplicate signUp", async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: "User already exists" }),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await service.signUp({ email: "existing@example.com", password: "secret123" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("email_exists")
    }
  })
})

describe("BetterAuthService getGoogleSignInUrl returns OAuth URL", () => {
  test("Returns URL with /api/auth/sign-in/social path", () => {
    const service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    const url = service.getGoogleSignInUrl()

    expect(url).toContain("/api/auth/sign-in/social")
  })

  test("Returns URL with provider=google query param", () => {
    const service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    const url = service.getGoogleSignInUrl()

    expect(url).toContain("provider=google")
  })

  test("Uses baseUrl from constructor config", () => {
    const service = new BetterAuthService({ baseUrl: "https://api.example.com" })
    const url = service.getGoogleSignInUrl()

    expect(url).toContain("https://api.example.com")
  })
})

describe("BetterAuthService signInWithGoogle redirects to OAuth URL", () => {
  let service: BetterAuthService
  let originalLocation: Location

  beforeEach(() => {
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
    // Mock window.location for browser environment tests
    originalLocation = globalThis.location
  })

  afterEach(() => {
    if (originalLocation) {
      globalThis.location = originalLocation
    }
  })

  test("Returns a Promise that resolves", async () => {
    // In non-browser environment, signInWithGoogle should still work without throwing
    // The actual redirect would only happen in browser context
    const result = service.signInWithGoogle()
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBeUndefined()
  })
})

describe("BetterAuthService onAuthStateChange manages subscriptions", () => {
  let service: BetterAuthService

  beforeEach(() => {
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  test("Returns unsubscribe function", () => {
    const unsubscribe = service.onAuthStateChange(() => {})
    expect(typeof unsubscribe).toBe("function")
  })

  test("Unsubscribe function can be called without error", () => {
    const unsubscribe = service.onAuthStateChange(() => {})
    expect(() => unsubscribe()).not.toThrow()
  })
})

/**
 * Task: task-ba-010
 * Requirement: req-ba-001
 *
 * Tests for onAuthStateChange with BA client nanostore subscription.
 * These tests verify:
 * - Subscribes to authClient.useSession nanostore
 * - Maps BA session data to AuthSession type
 * - Calls callback(null) when session is null
 * - Returns unsubscribe function for cleanup
 * - Nanostore detail is encapsulated
 *
 * SKIP: These tests are for task-ba-010 and require authClient config extension.
 * Implement in task-ba-010.
 */
describe.skip("BetterAuthService.onAuthStateChange with authClient (task-ba-010)", () => {
  // Track subscription state for verification
  let mockSubscriptionCallback: ((value: any) => void) | null = null
  let mockUnsubscribeCalled = false

  // Mock unsubscribe function
  const mockUnsubscribe = () => {
    mockUnsubscribeCalled = true
    mockSubscriptionCallback = null
  }

  // Mock subscribe function that captures the callback
  const mockSubscribe = mock((callback: (value: any) => void) => {
    mockSubscriptionCallback = callback
    return mockUnsubscribe
  })

  // Mock useSession with subscribe method (nanostore pattern)
  const mockUseSession = {
    subscribe: mockSubscribe,
  }

  // Mock auth client
  const mockAuthClient = {
    useSession: mockUseSession,
  }

  beforeEach(() => {
    mockSubscriptionCallback = null
    mockUnsubscribeCalled = false
    mockSubscribe.mockClear()
  })

  test("Accepts authClient as optional constructor parameter", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    expect(service).toBeDefined()
  })

  test("Subscribes to authClient.useSession nanostore when authClient provided", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
  })

  test("Maps BA session data to AuthSession type when session exists", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    // Simulate BA session data coming through the nanostore
    const baSessionData = {
      data: {
        session: {
          id: "session-123",
          token: "jwt-token-abc",
          userId: "user-456",
          expiresAt: new Date("2024-12-31T23:59:59Z"),
          ipAddress: "192.168.1.1",
          userAgent: "Mozilla/5.0",
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:30:00Z"),
        },
        user: {
          id: "user-456",
          email: "test@example.com",
          name: "Test User",
          image: "https://example.com/avatar.png",
          emailVerified: true,
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:00:00Z"),
        },
      },
      isPending: false,
      error: null,
    }

    // Trigger the subscription callback with BA data
    mockSubscriptionCallback!(baSessionData)

    expect(callback).toHaveBeenCalledTimes(1)
    const calls = callback.mock.calls as unknown[][]
    const mappedSession = calls[0]?.[0] as any

    expect(mappedSession).not.toBeNull()
    expect(mappedSession.accessToken).toBe("jwt-token-abc")
    expect(mappedSession.expiresAt).toBe("2024-12-31T23:59:59.000Z")
    expect(mappedSession.user.id).toBe("user-456")
    expect(mappedSession.user.email).toBe("test@example.com")
    expect(mappedSession.user.emailVerified).toBe(true)
  })

  test("Calls callback with null when BA session is null", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    // Simulate null session (signed out state)
    mockSubscriptionCallback!({
      data: null,
      isPending: false,
      error: null,
    })

    expect(callback).toHaveBeenCalledTimes(1)
    const calls = callback.mock.calls as unknown[][]
    expect(calls[0]?.[0]).toBeNull()
  })

  test("Calls callback with null when BA session data is empty", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    // Simulate empty session data
    mockSubscriptionCallback!({
      data: {
        session: null,
        user: null,
      },
      isPending: false,
      error: null,
    })

    expect(callback).toHaveBeenCalledTimes(1)
    const calls = callback.mock.calls as unknown[][]
    expect(calls[0]?.[0]).toBeNull()
  })

  test("Returns unsubscribe function that calls nanostore unsubscribe", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    const unsubscribe = service.onAuthStateChange(callback)

    expect(typeof unsubscribe).toBe("function")

    unsubscribe()

    expect(mockUnsubscribeCalled).toBe(true)
  })

  test("Nanostore subscription detail is encapsulated - not exposed on service", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })

    // The service should not expose internal details
    expect((service as any).$session).toBeUndefined()
    expect((service as any).useSession).toBeUndefined()
  })

  test("Maps refreshToken to null (BA sessions do not expose refresh tokens)", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    mockSubscriptionCallback!({
      data: {
        session: {
          id: "session-123",
          token: "jwt-token-abc",
          userId: "user-456",
          expiresAt: new Date("2024-12-31T23:59:59Z"),
          ipAddress: null,
          userAgent: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:00:00Z"),
        },
        user: {
          id: "user-456",
          email: "test@example.com",
          name: "Test User",
          image: null,
          emailVerified: false,
          createdAt: new Date("2024-01-01T00:00:00Z"),
          updatedAt: new Date("2024-01-01T00:00:00Z"),
        },
      },
      isPending: false,
      error: null,
    })

    const calls = callback.mock.calls as unknown[][]
    const mappedSession = calls[0]?.[0] as any
    expect(mappedSession.refreshToken).toBeNull()
  })

  test("Handles multiple state changes correctly", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    // First: signed out
    mockSubscriptionCallback!({
      data: null,
      isPending: false,
      error: null,
    })

    // Second: signed in
    mockSubscriptionCallback!({
      data: {
        session: {
          id: "session-123",
          token: "token-123",
          userId: "user-1",
          expiresAt: new Date("2024-12-31T23:59:59Z"),
          ipAddress: null,
          userAgent: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User",
          image: null,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isPending: false,
      error: null,
    })

    // Third: signed out again
    mockSubscriptionCallback!({
      data: null,
      isPending: false,
      error: null,
    })

    expect(callback).toHaveBeenCalledTimes(3)
    const calls = callback.mock.calls as unknown[][]
    expect(calls[0]?.[0]).toBeNull()
    expect(calls[1]?.[0]).not.toBeNull()
    expect(calls[2]?.[0]).toBeNull()
  })

  test("Correctly maps all AuthUser fields from BA user", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    const createdAt = new Date("2024-01-01T00:00:00Z")
    mockSubscriptionCallback!({
      data: {
        session: {
          id: "session-123",
          token: "token-abc",
          userId: "user-456",
          expiresAt: new Date("2024-12-31T23:59:59Z"),
          ipAddress: null,
          userAgent: null,
          createdAt: createdAt,
          updatedAt: createdAt,
        },
        user: {
          id: "user-456",
          email: "mapped@example.com",
          name: "Mapped User",
          image: "https://example.com/pic.png",
          emailVerified: true,
          createdAt: createdAt,
          updatedAt: createdAt,
        },
      },
      isPending: false,
      error: null,
    })

    const calls = callback.mock.calls as unknown[][]
    const mappedSession = calls[0]?.[0] as any

    // Verify AuthUser fields
    expect(mappedSession.user.id).toBe("user-456")
    expect(mappedSession.user.email).toBe("mapped@example.com")
    expect(mappedSession.user.emailVerified).toBe(true)
    expect(mappedSession.user.createdAt).toBe("2024-01-01T00:00:00.000Z")

    // Verify AuthSession fields
    expect(mappedSession.accessToken).toBe("token-abc")
    expect(mappedSession.expiresAt).toBe("2024-12-31T23:59:59.000Z")
    expect(mappedSession.refreshToken).toBeNull()
  })

  test("Does not invoke callback during isPending state", () => {
    const service = new BetterAuthService({
      baseUrl: "http://localhost:3000",
      authClient: mockAuthClient as any,
    })
    const callback = mock(() => {})

    service.onAuthStateChange(callback)

    // isPending state - should not trigger callback
    mockSubscriptionCallback!({
      data: null,
      isPending: true,
      error: null,
    })

    expect(callback).not.toHaveBeenCalled()
  })
})

describe("BetterAuthService mapping functions", () => {
  let service: BetterAuthService
  let mockFetch: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSessionResponse),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
    service = new BetterAuthService({ baseUrl: "http://localhost:3000" })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("Maps BetterAuthUser to AuthUser correctly", async () => {
    const session = await service.getSession()

    // AuthUser has: id, email, emailVerified, createdAt
    expect(session?.user.id).toBe("ba-user-123")
    expect(session?.user.email).toBe("test@example.com")
    expect(session?.user.emailVerified).toBe(true)
    expect(session?.user.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("Maps BetterAuthSession to AuthSession correctly", async () => {
    const session = await service.getSession()

    // AuthSession has: accessToken, refreshToken, expiresAt, user
    expect(session?.accessToken).toBe("ba-access-token-xyz")
    expect(session?.refreshToken).toBeNull() // BetterAuth uses cookie-based sessions
    expect(session?.expiresAt).toBe("2024-01-01T01:00:00Z")
  })

  test("Handles user with null image field", async () => {
    const userWithNullImage = { ...mockBetterAuthUser, image: null }
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            session: mockBetterAuthSession,
            user: userWithNullImage,
          }),
      } as Response)
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const session = await service.getSession()
    // Should still map correctly without throwing
    expect(session?.user.id).toBe("ba-user-123")
  })
})
