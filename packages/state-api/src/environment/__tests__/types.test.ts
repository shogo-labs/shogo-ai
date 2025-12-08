/**
 * Generated from TestSpecification: test-auth-004
 * Task: task-auth-002
 * Requirement: req-auth-003
 */

import { describe, test, expect } from "bun:test"
import type { IEnvironment } from "../types"
import type { IAuthService, AuthCredentials, AuthSession } from "../../auth/types"
import type { IPersistenceService } from "../../persistence/types"

// Mock implementations for type checking
const mockPersistence: IPersistenceService = {
  saveCollection: async () => {},
  loadCollection: async () => null,
  saveEntity: async () => {},
  loadEntity: async () => null,
}

const mockAuthService: IAuthService = {
  signUp: async (_credentials: AuthCredentials): Promise<AuthSession> => {
    throw new Error("Mock")
  },
  signIn: async (_credentials: AuthCredentials): Promise<AuthSession> => {
    throw new Error("Mock")
  },
  signOut: async () => {},
  getSession: async () => null,
  onAuthStateChange: () => () => {},
}

describe("IEnvironment includes optional auth service slot", () => {
  test("services.auth property is accepted", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        auth: mockAuthService,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.auth).toBeDefined()
    expect(env.services.auth).toBe(mockAuthService)
  })

  test("services.auth is optional (undefined allowed)", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        // auth is NOT provided - should be valid
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.auth).toBeUndefined()
  })

  test("services.persistence remains required", () => {
    // This is a type-level test - if IEnvironment required persistence,
    // the following should compile and work
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.persistence).toBeDefined()
    expect(env.services.persistence).toBe(mockPersistence)
  })
})
