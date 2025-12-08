/**
 * Generated from TestSpecifications: test-auth-001, test-auth-002, test-auth-003
 * Task: task-auth-001
 * Requirement: req-auth-001
 */

import { describe, test, expect } from "bun:test"
import type {
  IAuthService,
  AuthUser,
  AuthSession,
  AuthCredentials,
  AuthError,
} from "../types"

describe("IAuthService interface exports all required methods", () => {
  test("Interface includes signUp method", () => {
    // Type-level test: if this compiles, the interface has signUp
    const _typeCheck: IAuthService["signUp"] extends (
      credentials: AuthCredentials
    ) => Promise<AuthSession>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signIn method", () => {
    const _typeCheck: IAuthService["signIn"] extends (
      credentials: AuthCredentials
    ) => Promise<AuthSession>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes signOut method", () => {
    const _typeCheck: IAuthService["signOut"] extends () => Promise<void>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes getSession method", () => {
    const _typeCheck: IAuthService["getSession"] extends () => Promise<AuthSession | null>
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })

  test("Interface includes onAuthStateChange method", () => {
    const _typeCheck: IAuthService["onAuthStateChange"] extends (
      callback: (session: AuthSession | null) => void
    ) => () => void
      ? true
      : never = true
    expect(_typeCheck).toBe(true)
  })
})

describe("AuthUser type has required fields", () => {
  test("Type includes id field", () => {
    const user: AuthUser = {
      id: "test-id",
      email: "test@example.com",
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
    }
    expect(user.id).toBe("test-id")
  })

  test("Type includes email field", () => {
    const user: AuthUser = {
      id: "test-id",
      email: "test@example.com",
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
    }
    expect(user.email).toBe("test@example.com")
  })

  test("Type includes emailVerified field", () => {
    const user: AuthUser = {
      id: "test-id",
      email: "test@example.com",
      emailVerified: true,
      createdAt: "2024-01-01T00:00:00Z",
    }
    expect(user.emailVerified).toBe(true)
  })

  test("Type includes createdAt field", () => {
    const user: AuthUser = {
      id: "test-id",
      email: "test@example.com",
      emailVerified: false,
      createdAt: "2024-01-01T00:00:00Z",
    }
    expect(user.createdAt).toBe("2024-01-01T00:00:00Z")
  })
})

describe("AuthSession type has required fields", () => {
  test("Type includes accessToken field", () => {
    const session: AuthSession = {
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: "2024-01-01T01:00:00Z",
      user: {
        id: "user-id",
        email: "test@example.com",
        emailVerified: false,
        createdAt: "2024-01-01T00:00:00Z",
      },
    }
    expect(session.accessToken).toBe("token-123")
  })

  test("Type includes refreshToken field", () => {
    const session: AuthSession = {
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: "2024-01-01T01:00:00Z",
      user: {
        id: "user-id",
        email: "test@example.com",
        emailVerified: false,
        createdAt: "2024-01-01T00:00:00Z",
      },
    }
    expect(session.refreshToken).toBe("refresh-456")
  })

  test("Type includes expiresAt field", () => {
    const session: AuthSession = {
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: "2024-01-01T01:00:00Z",
      user: {
        id: "user-id",
        email: "test@example.com",
        emailVerified: false,
        createdAt: "2024-01-01T00:00:00Z",
      },
    }
    expect(session.expiresAt).toBe("2024-01-01T01:00:00Z")
  })

  test("Type includes user field", () => {
    const session: AuthSession = {
      accessToken: "token-123",
      refreshToken: "refresh-456",
      expiresAt: "2024-01-01T01:00:00Z",
      user: {
        id: "user-id",
        email: "test@example.com",
        emailVerified: false,
        createdAt: "2024-01-01T00:00:00Z",
      },
    }
    expect(session.user.id).toBe("user-id")
    expect(session.user.email).toBe("test@example.com")
  })
})

describe("AuthCredentials type has required fields", () => {
  test("Type includes email and password fields", () => {
    const credentials: AuthCredentials = {
      email: "test@example.com",
      password: "secret123",
    }
    expect(credentials.email).toBe("test@example.com")
    expect(credentials.password).toBe("secret123")
  })
})

describe("AuthError type has required fields", () => {
  test("Type includes code and message fields", () => {
    const error: AuthError = {
      code: "invalid_credentials",
      message: "Invalid email or password",
    }
    expect(error.code).toBe("invalid_credentials")
    expect(error.message).toBe("Invalid email or password")
  })
})
