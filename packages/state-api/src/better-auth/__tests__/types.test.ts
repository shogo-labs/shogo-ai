/**
 * Tests for BetterAuth Types
 * Task: task-ba-001
 *
 * TDD: These tests are written BEFORE the implementation.
 * They should fail (RED) until types.ts is created.
 */

import { describe, test, expect } from "bun:test"
import type {
  BetterAuthUser,
  BetterAuthSession,
  BetterAuthAccount,
  IBetterAuthService,
} from "../types"
import type { IAuthService, AuthCredentials, AuthSession } from "../../auth/types"

describe("BetterAuthUser type has required fields", () => {
  test("Type includes id field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: "https://example.com/avatar.png",
      emailVerified: true,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(user.id).toBe("user-123")
  })

  test("Type includes email field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: null,
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(user.email).toBe("test@example.com")
  })

  test("Type includes name field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "John Doe",
      image: null,
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(user.name).toBe("John Doe")
  })

  test("Type includes image field (nullable)", () => {
    const userWithImage: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: "https://example.com/avatar.png",
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(userWithImage.image).toBe("https://example.com/avatar.png")

    const userWithoutImage: BetterAuthUser = {
      id: "user-456",
      email: "test2@example.com",
      name: "Test User 2",
      image: null,
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(userWithoutImage.image).toBe(null)
  })

  test("Type includes emailVerified field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: null,
      emailVerified: true,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(user.emailVerified).toBe(true)
  })

  test("Type includes createdAt field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: null,
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(user.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("Type includes updatedAt field", () => {
    const user: BetterAuthUser = {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
      image: null,
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    }
    expect(user.updatedAt).toBe("2024-01-02T00:00:00Z")
  })
})

describe("BetterAuthSession type has required fields", () => {
  test("Type includes id field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: "192.168.1.1",
      userAgent: "Mozilla/5.0",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(session.id).toBe("session-123")
  })

  test("Type includes token field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(session.token).toBe("jwt-token-abc")
  })

  test("Type includes userId field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-456",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(session.userId).toBe("user-456")
  })

  test("Type includes expiresAt field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-12-31T23:59:59Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(session.expiresAt).toBe("2024-12-31T23:59:59Z")
  })

  test("Type includes ipAddress field (nullable)", () => {
    const sessionWithIp: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: "10.0.0.1",
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(sessionWithIp.ipAddress).toBe("10.0.0.1")

    const sessionWithoutIp: BetterAuthSession = {
      id: "session-456",
      token: "jwt-token-def",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(sessionWithoutIp.ipAddress).toBe(null)
  })

  test("Type includes userAgent field (nullable)", () => {
    const sessionWithAgent: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: "Chrome/120.0",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(sessionWithAgent.userAgent).toBe("Chrome/120.0")

    const sessionWithoutAgent: BetterAuthSession = {
      id: "session-456",
      token: "jwt-token-def",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(sessionWithoutAgent.userAgent).toBe(null)
  })

  test("Type includes createdAt field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(session.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("Type includes updatedAt field", () => {
    const session: BetterAuthSession = {
      id: "session-123",
      token: "jwt-token-abc",
      userId: "user-123",
      expiresAt: "2024-01-01T01:00:00Z",
      ipAddress: null,
      userAgent: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:30:00Z",
    }
    expect(session.updatedAt).toBe("2024-01-01T00:30:00Z")
  })
})

describe("BetterAuthAccount type has required fields", () => {
  test("Type includes id field", () => {
    const account: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: "access-token-xyz",
      refreshToken: "refresh-token-xyz",
      accessTokenExpiresAt: "2024-01-01T01:00:00Z",
      refreshTokenExpiresAt: "2024-01-08T00:00:00Z",
      scope: "openid email profile",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(account.id).toBe("account-123")
  })

  test("Type includes userId field", () => {
    const account: BetterAuthAccount = {
      id: "account-123",
      userId: "user-456",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(account.userId).toBe("user-456")
  })

  test("Type includes accountId field", () => {
    const account: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "provider-specific-id-123",
      providerId: "github",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(account.accountId).toBe("provider-specific-id-123")
  })

  test("Type includes providerId field", () => {
    const account: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(account.providerId).toBe("google")
  })

  test("Type includes token fields (nullable)", () => {
    const accountWithTokens: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: "access-token-xyz",
      refreshToken: "refresh-token-xyz",
      accessTokenExpiresAt: "2024-01-01T01:00:00Z",
      refreshTokenExpiresAt: "2024-01-08T00:00:00Z",
      scope: "openid email profile",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(accountWithTokens.accessToken).toBe("access-token-xyz")
    expect(accountWithTokens.refreshToken).toBe("refresh-token-xyz")
    expect(accountWithTokens.accessTokenExpiresAt).toBe("2024-01-01T01:00:00Z")
    expect(accountWithTokens.refreshTokenExpiresAt).toBe("2024-01-08T00:00:00Z")

    const accountWithoutTokens: BetterAuthAccount = {
      id: "account-456",
      userId: "user-123",
      accountId: "github-oauth-id-abc",
      providerId: "github",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(accountWithoutTokens.accessToken).toBe(null)
    expect(accountWithoutTokens.refreshToken).toBe(null)
  })

  test("Type includes scope field (nullable)", () => {
    const accountWithScope: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: "openid email profile",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(accountWithScope.scope).toBe("openid email profile")

    const accountWithoutScope: BetterAuthAccount = {
      id: "account-456",
      userId: "user-123",
      accountId: "github-oauth-id-abc",
      providerId: "github",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    expect(accountWithoutScope.scope).toBe(null)
  })

  test("Type includes timestamps", () => {
    const account: BetterAuthAccount = {
      id: "account-123",
      userId: "user-123",
      accountId: "google-oauth-id-abc",
      providerId: "google",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T12:00:00Z",
    }
    expect(account.createdAt).toBe("2024-01-01T00:00:00Z")
    expect(account.updatedAt).toBe("2024-01-02T12:00:00Z")
  })
})

describe("IBetterAuthService extends IAuthService", () => {
  test("Interface extends IAuthService (inherits base methods)", () => {
    // Type-level test: IBetterAuthService should be assignable to IAuthService
    const _typeCheck: IBetterAuthService extends IAuthService ? true : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signUp method from IAuthService", () => {
    const _typeCheck: IBetterAuthService["signUp"] extends (
      credentials: AuthCredentials
    ) => Promise<AuthSession>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signIn method from IAuthService", () => {
    const _typeCheck: IBetterAuthService["signIn"] extends (
      credentials: AuthCredentials
    ) => Promise<AuthSession>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signOut method from IAuthService", () => {
    const _typeCheck: IBetterAuthService["signOut"] extends () => Promise<void>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes getSession method from IAuthService", () => {
    const _typeCheck: IBetterAuthService["getSession"] extends () => Promise<AuthSession | null>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes onAuthStateChange method from IAuthService", () => {
    const _typeCheck: IBetterAuthService["onAuthStateChange"] extends (
      callback: (session: AuthSession | null) => void
    ) => () => void
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signInWithGoogle method", () => {
    const _typeCheck: IBetterAuthService["signInWithGoogle"] extends () => Promise<void>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes getGoogleSignInUrl method", () => {
    const _typeCheck: IBetterAuthService["getGoogleSignInUrl"] extends () => string
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })
})
