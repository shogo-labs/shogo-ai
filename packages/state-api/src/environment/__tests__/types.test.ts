/**
 * Generated from TestSpecification: test-010, test-011
 * Task: task-auth-004
 * Requirement: req-auth-006
 */

import { describe, test, expect } from "bun:test"
import type { IEnvironment } from "../types"
import type { IAuthService, AuthResult, AuthSession } from "../../auth/types"
import type { IPersistenceService } from "../../persistence/types"

// Minimal mock implementations for type testing
const mockPersistence: IPersistenceService = {
  saveCollection: async () => {},
  loadCollection: async () => [],
  saveEntity: async () => {},
  loadEntity: async () => null,
}

const mockAuthService: IAuthService = {
  signUp: async (_email: string, _password: string): Promise<AuthResult> => ({
    user: null,
    error: null,
  }),
  signIn: async (_email: string, _password: string): Promise<AuthResult> => ({
    user: null,
    error: null,
  }),
  signOut: async (): Promise<void> => {},
  getSession: async (): Promise<AuthSession | null> => null,
  onAuthStateChange: (_callback: (session: AuthSession | null) => void) => () => {},
}

describe("IEnvironment accepts optional auth service", () => {
  test("services.auth can be set to IAuthService implementation", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        auth: mockAuthService,
      },
      context: {
        schemaName: "TestSchema",
      },
    }

    expect(env.services.auth).toBeDefined()
    expect(env.services.auth).toBe(mockAuthService)
  })

  test("Environment is valid TypeScript with auth service", () => {
    // This test verifies that the TypeScript compiles correctly
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        auth: mockAuthService,
      },
      context: {
        schemaName: "TestSchema",
        location: "./test-workspace",
      },
    }

    // If this compiles, the interface is correctly defined
    expect(env.services.persistence).toBeDefined()
    expect(env.services.auth).toBeDefined()
    expect(env.context.schemaName).toBe("TestSchema")
  })
})

describe("IEnvironment works without auth service", () => {
  test("services.auth is undefined when not provided", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
      },
      context: {
        schemaName: "TestSchema",
      },
    }

    expect(env.services.auth).toBeUndefined()
  })

  test("Existing persistence-only environments still work", () => {
    // This is the pattern from existing code
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
      },
      context: {
        schemaName: "MinimalCMS",
        location: ".schemas",
      },
    }

    // Should work exactly as before
    expect(env.services.persistence).toBe(mockPersistence)
    expect(env.context.schemaName).toBe("MinimalCMS")
  })

  test("No TypeScript errors without auth", () => {
    // Create environment without auth - should compile without errors
    const createEnv = (): IEnvironment => ({
      services: {
        persistence: mockPersistence,
      },
      context: {
        schemaName: "Test",
      },
    })

    const env = createEnv()
    expect(env).toBeDefined()
  })
})
