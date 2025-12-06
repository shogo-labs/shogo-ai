/**
 * Generated from TestSpecification: test-003 through test-009
 * Task: task-auth-003
 * Requirement: req-auth-006
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { MockAuthService } from "../mock"
import type { AuthSession } from "../types"

describe("MockAuthService signUp creates new user", () => {
  let service: MockAuthService

  beforeEach(() => {
    service = new MockAuthService()
  })

  test("Returns AuthResult with user containing the email", async () => {
    const result = await service.signUp("test@example.com", "password123")
    expect(result.user).not.toBeNull()
    expect(result.user?.email).toBe("test@example.com")
  })

  test("User is assigned a UUID id", async () => {
    const result = await service.signUp("test@example.com", "password123")
    expect(result.user?.id).toBeDefined()
    expect(result.user?.id.length).toBeGreaterThan(0)
  })

  test("User has createdAt timestamp", async () => {
    const result = await service.signUp("test@example.com", "password123")
    expect(result.user?.createdAt).toBeDefined()
  })

  test("Current session is set to the new user", async () => {
    await service.signUp("test@example.com", "password123")
    const session = await service.getSession()
    expect(session).not.toBeNull()
    expect(session?.user?.email).toBe("test@example.com")
  })
})

describe("MockAuthService signUp rejects duplicate email", () => {
  let service: MockAuthService

  beforeEach(async () => {
    service = new MockAuthService()
    await service.signUp("test@example.com", "password123")
  })

  test("Returns AuthResult with user: null for duplicate", async () => {
    const result = await service.signUp("test@example.com", "newpassword")
    expect(result.user).toBeNull()
  })

  test("Returns AuthResult with error: 'Email already registered'", async () => {
    const result = await service.signUp("test@example.com", "newpassword")
    expect(result.error).toBe("Email already registered")
  })
})

describe("MockAuthService signIn validates credentials", () => {
  let service: MockAuthService

  beforeEach(async () => {
    service = new MockAuthService()
    await service.signUp("test@example.com", "password123")
    await service.signOut() // Clear session after signup
  })

  test("Returns AuthResult with user for valid credentials", async () => {
    const result = await service.signIn("test@example.com", "password123")
    expect(result.user).not.toBeNull()
    expect(result.user?.email).toBe("test@example.com")
  })

  test("Current session is set to the user", async () => {
    await service.signIn("test@example.com", "password123")
    const session = await service.getSession()
    expect(session?.user?.email).toBe("test@example.com")
  })
})

describe("MockAuthService signIn rejects invalid credentials", () => {
  let service: MockAuthService

  beforeEach(async () => {
    service = new MockAuthService()
    await service.signUp("test@example.com", "password123")
    await service.signOut()
  })

  test("Returns AuthResult with user: null for wrong password", async () => {
    const result = await service.signIn("test@example.com", "wrongpassword")
    expect(result.user).toBeNull()
  })

  test("Returns AuthResult with error: 'Invalid credentials'", async () => {
    const result = await service.signIn("test@example.com", "wrongpassword")
    expect(result.error).toBe("Invalid credentials")
  })

  test("Returns error for non-existent user", async () => {
    const result = await service.signIn("nonexistent@example.com", "password123")
    expect(result.user).toBeNull()
    expect(result.error).toBe("Invalid credentials")
  })
})

describe("MockAuthService signOut clears session", () => {
  let service: MockAuthService

  beforeEach(async () => {
    service = new MockAuthService()
    await service.signUp("test@example.com", "password123")
  })

  test("getSession returns null after signOut", async () => {
    await service.signOut()
    const session = await service.getSession()
    expect(session).toBeNull()
  })

  test("Resolves without error", async () => {
    await expect(service.signOut()).resolves.toBeUndefined()
  })
})

describe("MockAuthService onAuthStateChange fires on state changes", () => {
  let service: MockAuthService
  let receivedSessions: (AuthSession | null)[]

  beforeEach(() => {
    service = new MockAuthService()
    receivedSessions = []
  })

  test("Callback is invoked with new session on signIn", async () => {
    // First sign up a user
    await service.signUp("test@example.com", "password123")
    await service.signOut()

    // Register callback
    service.onAuthStateChange((session) => {
      receivedSessions.push(session)
    })

    // Sign in
    await service.signIn("test@example.com", "password123")

    expect(receivedSessions.length).toBeGreaterThan(0)
    expect(receivedSessions[receivedSessions.length - 1]?.user?.email).toBe("test@example.com")
  })

  test("Callback is invoked on signUp", async () => {
    service.onAuthStateChange((session) => {
      receivedSessions.push(session)
    })

    await service.signUp("test@example.com", "password123")

    expect(receivedSessions.length).toBeGreaterThan(0)
    expect(receivedSessions[receivedSessions.length - 1]?.user?.email).toBe("test@example.com")
  })

  test("Callback is invoked with null on signOut", async () => {
    await service.signUp("test@example.com", "password123")

    service.onAuthStateChange((session) => {
      receivedSessions.push(session)
    })

    await service.signOut()

    expect(receivedSessions.length).toBeGreaterThan(0)
    expect(receivedSessions[receivedSessions.length - 1]).toBeNull()
  })

  test("Unsubscribe function stops callbacks", async () => {
    const unsubscribe = service.onAuthStateChange((session) => {
      receivedSessions.push(session)
    })

    await service.signUp("test@example.com", "password123")
    const countAfterSignup = receivedSessions.length

    unsubscribe()

    await service.signOut()
    expect(receivedSessions.length).toBe(countAfterSignup)
  })
})

describe("MockAuthService reset clears all state", () => {
  let service: MockAuthService

  beforeEach(async () => {
    service = new MockAuthService()
    await service.signUp("test@example.com", "password123")
  })

  test("All registered users are cleared", async () => {
    service.reset()
    const result = await service.signIn("test@example.com", "password123")
    expect(result.user).toBeNull()
    expect(result.error).toBe("Invalid credentials")
  })

  test("Current session is cleared", async () => {
    service.reset()
    const session = await service.getSession()
    expect(session).toBeNull()
  })

  test("Service can be reused for new test", async () => {
    service.reset()
    const result = await service.signUp("new@example.com", "newpassword")
    expect(result.user?.email).toBe("new@example.com")
  })
})
