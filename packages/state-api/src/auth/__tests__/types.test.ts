/**
 * Generated from TestSpecification: test-001, test-002
 * Task: task-auth-001
 * Requirement: req-auth-006
 */

import { describe, test, expect } from "bun:test"
import type {
  IAuthService,
  AuthResult,
  AuthUser,
  AuthSession,
} from "../types"

describe("IAuthService interface exports correct methods", () => {
  test("Interface includes signUp method with email and password params returning Promise<AuthResult>", () => {
    // Type-level test: if this compiles, the interface is correct
    const mockService: IAuthService = {
      signUp: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signIn: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signOut: async (): Promise<void> => {},
      getSession: async (): Promise<AuthSession | null> => null,
      onAuthStateChange: (_callback: (session: AuthSession | null) => void) => {
        return () => {}
      },
    }
    expect(mockService.signUp).toBeDefined()
  })

  test("Interface includes signIn method with email and password params returning Promise<AuthResult>", () => {
    const mockService: IAuthService = {
      signUp: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signIn: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signOut: async (): Promise<void> => {},
      getSession: async (): Promise<AuthSession | null> => null,
      onAuthStateChange: (_callback: (session: AuthSession | null) => void) => {
        return () => {}
      },
    }
    expect(mockService.signIn).toBeDefined()
  })

  test("Interface includes signOut method returning Promise<void>", () => {
    const mockService: IAuthService = {
      signUp: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signIn: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signOut: async (): Promise<void> => {},
      getSession: async (): Promise<AuthSession | null> => null,
      onAuthStateChange: (_callback: (session: AuthSession | null) => void) => {
        return () => {}
      },
    }
    expect(mockService.signOut).toBeDefined()
  })

  test("Interface includes getSession method returning Promise<AuthSession | null>", () => {
    const mockService: IAuthService = {
      signUp: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signIn: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signOut: async (): Promise<void> => {},
      getSession: async (): Promise<AuthSession | null> => null,
      onAuthStateChange: (_callback: (session: AuthSession | null) => void) => {
        return () => {}
      },
    }
    expect(mockService.getSession).toBeDefined()
  })

  test("Interface includes onAuthStateChange method accepting callback returning unsubscribe function", () => {
    const mockService: IAuthService = {
      signUp: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signIn: async (_email: string, _password: string): Promise<AuthResult> => {
        return { user: null, error: null }
      },
      signOut: async (): Promise<void> => {},
      getSession: async (): Promise<AuthSession | null> => null,
      onAuthStateChange: (_callback: (session: AuthSession | null) => void) => {
        return () => {}
      },
    }
    const unsubscribe = mockService.onAuthStateChange(() => {})
    expect(typeof unsubscribe).toBe("function")
  })
})

describe("Auth types are correctly defined", () => {
  test("AuthResult has user field (AuthUser | null) and error field (string | null)", () => {
    const successResult: AuthResult = {
      user: { id: "123", email: "test@example.com", createdAt: "2024-01-01T00:00:00Z" },
      error: null,
    }
    const errorResult: AuthResult = {
      user: null,
      error: "Invalid credentials",
    }
    expect(successResult.user).not.toBeNull()
    expect(successResult.error).toBeNull()
    expect(errorResult.user).toBeNull()
    expect(errorResult.error).not.toBeNull()
  })

  test("AuthUser has id (string), email (string), createdAt (string) fields", () => {
    const user: AuthUser = {
      id: "user-123",
      email: "test@example.com",
      createdAt: "2024-01-01T00:00:00Z",
    }
    expect(user.id).toBe("user-123")
    expect(user.email).toBe("test@example.com")
    expect(user.createdAt).toBe("2024-01-01T00:00:00Z")
  })

  test("AuthSession has user (AuthUser | null) and lastRefreshedAt (string) fields", () => {
    const sessionWithUser: AuthSession = {
      user: { id: "123", email: "test@example.com", createdAt: "2024-01-01T00:00:00Z" },
      lastRefreshedAt: "2024-01-01T12:00:00Z",
    }
    const sessionWithoutUser: AuthSession = {
      user: null,
      lastRefreshedAt: "2024-01-01T12:00:00Z",
    }
    expect(sessionWithUser.user).not.toBeNull()
    expect(sessionWithUser.lastRefreshedAt).toBe("2024-01-01T12:00:00Z")
    expect(sessionWithoutUser.user).toBeNull()
  })
})
