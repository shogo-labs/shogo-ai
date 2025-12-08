/**
 * Generated from TestSpecifications: test-auth-005 to test-auth-011
 * Task: task-auth-003
 * Requirement: req-auth-005
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { MockAuthService } from "../mock"
import type { AuthError } from "../types"

describe("MockAuthService signUp creates user and returns session", () => {
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
  })

  test("Returns AuthSession with accessToken", async () => {
    const session = await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.accessToken).toBeDefined()
    expect(typeof session.accessToken).toBe("string")
    expect(session.accessToken.length).toBeGreaterThan(0)
  })

  test("Returns AuthSession with user containing provided email", async () => {
    const session = await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.user).toBeDefined()
    expect(session.user.email).toBe("test@example.com")
  })

  test("User is stored in internal Map", async () => {
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    // Verify by signing in with same credentials
    const session = await authService.signIn({
      email: "test@example.com",
      password: "secret123",
    })
    expect(session.user.email).toBe("test@example.com")
  })

  test("Subsequent getSession returns the session", async () => {
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    const session = await authService.getSession()
    expect(session).not.toBeNull()
    expect(session?.user.email).toBe("test@example.com")
  })
})

describe("MockAuthService signUp rejects duplicate email", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("Throws AuthError with code 'email_exists'", async () => {
    try {
      await authService.signUp({
        email: "test@example.com",
        password: "different",
      })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("email_exists")
    }
  })

  test("No duplicate user is created", async () => {
    try {
      await authService.signUp({
        email: "test@example.com",
        password: "different",
      })
    } catch {
      // Expected
    }

    // Original user should still work
    const session = await authService.signIn({
      email: "test@example.com",
      password: "secret123",
    })
    expect(session.user.email).toBe("test@example.com")
  })
})

describe("MockAuthService signIn validates credentials", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
    await authService.signOut() // Clear session from signUp
  })

  test("Returns AuthSession with accessToken", async () => {
    const session = await authService.signIn({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.accessToken).toBeDefined()
    expect(typeof session.accessToken).toBe("string")
  })

  test("Returns AuthSession with user matching email", async () => {
    const session = await authService.signIn({
      email: "test@example.com",
      password: "secret123",
    })

    expect(session.user.email).toBe("test@example.com")
  })
})

describe("MockAuthService signIn rejects invalid credentials", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
    await authService.signOut()
  })

  test("Throws AuthError with code 'invalid_credentials'", async () => {
    try {
      await authService.signIn({
        email: "test@example.com",
        password: "wrongpassword",
      })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("invalid_credentials")
    }
  })

  test("No session is created", async () => {
    try {
      await authService.signIn({
        email: "test@example.com",
        password: "wrongpassword",
      })
    } catch {
      // Expected
    }

    const session = await authService.getSession()
    expect(session).toBeNull()
  })
})

describe("MockAuthService signOut clears session", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("getSession returns null after signOut", async () => {
    await authService.signOut()

    const session = await authService.getSession()
    expect(session).toBeNull()
  })

  test("onAuthStateChange subscribers are notified with null", async () => {
    const notifications: (unknown | null)[] = []
    authService.onAuthStateChange((session) => {
      notifications.push(session)
    })

    await authService.signOut()

    expect(notifications).toContainEqual(null)
  })
})

describe("MockAuthService onAuthStateChange notifies on sign in/out", () => {
  let authService: MockAuthService

  beforeEach(() => {
    authService = new MockAuthService()
  })

  test("Subscriber is called with session on sign in", async () => {
    const notifications: unknown[] = []
    authService.onAuthStateChange((session) => {
      notifications.push(session)
    })

    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    // Should have received the session
    expect(notifications.length).toBeGreaterThan(0)
    const lastNotification = notifications[notifications.length - 1] as any
    expect(lastNotification?.user?.email).toBe("test@example.com")
  })

  test("Subscriber is called with null on sign out", async () => {
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })

    const notifications: (unknown | null)[] = []
    authService.onAuthStateChange((session) => {
      notifications.push(session)
    })

    await authService.signOut()

    expect(notifications).toContainEqual(null)
  })
})

describe("MockAuthService clear resets all state", () => {
  let authService: MockAuthService

  beforeEach(async () => {
    authService = new MockAuthService()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
  })

  test("getSession returns null after clear", () => {
    authService.clear()

    // Need to check synchronously or via getSession
    // Since clear is sync, session should be null
    authService.getSession().then((session) => {
      expect(session).toBeNull()
    })
  })

  test("Previous user credentials no longer work for signIn", async () => {
    authService.clear()

    try {
      await authService.signIn({
        email: "test@example.com",
        password: "secret123",
      })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("invalid_credentials")
    }
  })

  test("signUp with same email succeeds after clear", async () => {
    authService.clear()

    const session = await authService.signUp({
      email: "test@example.com",
      password: "newpassword",
    })

    expect(session.user.email).toBe("test@example.com")
  })
})

describe("MockAuthService configurable delays", () => {
  test("Operations can be delayed via constructor options", async () => {
    const authService = new MockAuthService({ delay: 50 })

    const start = Date.now()
    await authService.signUp({
      email: "test@example.com",
      password: "secret123",
    })
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(40) // Allow some tolerance
  })
})
