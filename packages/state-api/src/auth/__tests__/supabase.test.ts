/**
 * Generated from TestSpecifications: test-auth-012 to test-auth-016
 * Task: task-auth-004
 * Requirement: req-auth-004
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SupabaseAuthService } from "../supabase"
import type { AuthError } from "../types"

// Mock Supabase client type (minimal interface for testing)
interface MockSupabaseClient {
  auth: {
    signUp: ReturnType<typeof mock>
    signInWithPassword: ReturnType<typeof mock>
    signOut: ReturnType<typeof mock>
    getSession: ReturnType<typeof mock>
    onAuthStateChange: ReturnType<typeof mock>
  }
}

function createMockSupabaseClient(): MockSupabaseClient {
  return {
    auth: {
      signUp: mock(() => Promise.resolve({ data: { session: null, user: null }, error: null })),
      signInWithPassword: mock(() => Promise.resolve({ data: { session: null, user: null }, error: null })),
      signOut: mock(() => Promise.resolve({ error: null })),
      getSession: mock(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: mock(() => ({ data: { subscription: { unsubscribe: mock(() => {}) } } })),
    },
  }
}

// Mock Supabase response structures
const mockSupabaseUser = {
  id: "supabase-user-123",
  email: "test@example.com",
  email_confirmed_at: "2024-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
}

const mockSupabaseSession = {
  access_token: "supabase-access-token",
  refresh_token: "supabase-refresh-token",
  expires_at: 1704070800, // Unix timestamp
  user: mockSupabaseUser,
}

describe("SupabaseAuthService signUp calls supabase.auth.signUp", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    mockClient.auth.signUp = mock(() =>
      Promise.resolve({
        data: { session: mockSupabaseSession, user: mockSupabaseUser },
        error: null,
      })
    )
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("supabase.auth.signUp is called with { email, password }", async () => {
    await authService.signUp({ email: "test@example.com", password: "secret123" })

    expect(mockClient.auth.signUp).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Returns AuthSession mapped from Supabase response", async () => {
    const session = await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.accessToken).toBe("supabase-access-token")
    expect(session.refreshToken).toBe("supabase-refresh-token")
  })

  test("AuthUser contains id and email from Supabase user", async () => {
    const session = await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.user.id).toBe("supabase-user-123")
    expect(session.user.email).toBe("test@example.com")
  })
})

describe("SupabaseAuthService signIn calls supabase.auth.signInWithPassword", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    mockClient.auth.signInWithPassword = mock(() =>
      Promise.resolve({
        data: { session: mockSupabaseSession, user: mockSupabaseUser },
        error: null,
      })
    )
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("supabase.auth.signInWithPassword is called with { email, password }", async () => {
    await authService.signIn({ email: "test@example.com", password: "secret123" })

    expect(mockClient.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Returns AuthSession with accessToken from Supabase", async () => {
    const session = await authService.signIn({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.accessToken).toBe("supabase-access-token")
  })
})

describe("SupabaseAuthService converts Supabase errors to AuthError", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    mockClient.auth.signInWithPassword = mock(() =>
      Promise.resolve({
        data: { session: null, user: null },
        error: { message: "Invalid login credentials", status: 400 },
      })
    )
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("Throws AuthError with code mapped from Supabase error", async () => {
    try {
      await authService.signIn({ email: "test@example.com", password: "wrong" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBeDefined()
      expect(typeof authError.code).toBe("string")
    }
  })

  test("AuthError message contains original error message", async () => {
    try {
      await authService.signIn({ email: "test@example.com", password: "wrong" })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.message).toContain("Invalid login credentials")
    }
  })
})

describe("SupabaseAuthService getSession handles null session", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    mockClient.auth.getSession = mock(() =>
      Promise.resolve({
        data: { session: null },
        error: null,
      })
    )
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("Returns null without throwing", async () => {
    const session = await authService.getSession()
    expect(session).toBeNull()
  })

  test("Does not attempt to map null to AuthSession", async () => {
    // This test verifies no crash when session is null
    const session = await authService.getSession()
    expect(session).toBeNull()
    // If we reach here without error, mapping null was handled correctly
  })
})

describe("SupabaseAuthService onAuthStateChange wraps Supabase listener", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService
  let mockUnsubscribe: ReturnType<typeof mock>

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    mockUnsubscribe = mock(() => {})
    mockClient.auth.onAuthStateChange = mock(() => ({
      data: { subscription: { unsubscribe: mockUnsubscribe } },
    }))
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("supabase.auth.onAuthStateChange is called", () => {
    authService.onAuthStateChange(() => {})

    expect(mockClient.auth.onAuthStateChange).toHaveBeenCalled()
  })

  test("Returns unsubscribe function", () => {
    const unsubscribe = authService.onAuthStateChange(() => {})

    expect(typeof unsubscribe).toBe("function")
  })

  test("Callback receives mapped AuthSession on state change", () => {
    // Capture the callback passed to Supabase
    let supabaseCallback: ((event: string, session: any) => void) | null = null
    mockClient.auth.onAuthStateChange = mock((cb: any) => {
      supabaseCallback = cb
      return { data: { subscription: { unsubscribe: mockUnsubscribe } } }
    })

    authService = new SupabaseAuthService(mockClient as any)

    const receivedSessions: any[] = []
    authService.onAuthStateChange((session) => {
      receivedSessions.push(session)
    })

    // Simulate Supabase calling the callback
    // Use non-null assertion since the mock assigned the callback
    supabaseCallback!("SIGNED_IN", mockSupabaseSession)

    expect(receivedSessions.length).toBe(1)
    expect(receivedSessions[0]?.accessToken).toBe("supabase-access-token")
  })
})

describe("SupabaseAuthService signOut calls supabase.auth.signOut", () => {
  let mockClient: MockSupabaseClient
  let authService: SupabaseAuthService

  beforeEach(() => {
    mockClient = createMockSupabaseClient()
    authService = new SupabaseAuthService(mockClient as any)
  })

  test("supabase.auth.signOut is called", async () => {
    await authService.signOut()

    expect(mockClient.auth.signOut).toHaveBeenCalled()
  })
})
