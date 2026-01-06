/**
 * Generated from TestSpecification: test-auth-004
 * Task: task-auth-002
 * Requirement: req-auth-003
 */

import { describe, test, expect } from "bun:test"
import type { IEnvironment } from "../types"
import type { IAuthService, AuthCredentials, AuthSession } from "../../auth/types"
import type { IPersistenceService } from "../../persistence/types"
import type { IBackendRegistry } from "../../query/registry"
import type { IQueryValidator } from "../../query/validation/types"
import type { Condition } from "../../query/ast/types"

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

const mockBackendRegistry: IBackendRegistry = {
  register: () => {},
  get: () => undefined,
  has: () => false,
  resolve: () => {
    throw new Error("Mock backend registry")
  },
  setDefault: () => {},
  executeDDL: async () => ({ success: true, statements: [], executed: 0 }),
  getBootstrapSchemas: () => [],
  initialize: async () => {},
  syncSchema: async () => ({ action: "bootstrap" as const }),
}

const mockQueryValidator: IQueryValidator = {
  validateQuery: (_ast: Condition, _schemaName: string, _modelName: string) => ({
    valid: true,
    errors: [],
  }),
}

describe("IEnvironment includes optional auth service slot", () => {
  test("services.auth property is accepted", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
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
        backendRegistry: mockBackendRegistry,
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
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.persistence).toBeDefined()
    expect(env.services.persistence).toBe(mockPersistence)
  })
})

/**
 * Generated from TestSpecification: test-env-backend-registry
 * Task: task-environment-extension
 * Requirement: req-06-isomorphic-execution
 */
describe("IEnvironment.services includes backendRegistry", () => {
  test("services.backendRegistry is optional property", () => {
    // backendRegistry is optional - not all contexts need query capabilities
    const envWithoutRegistry: IEnvironment = {
      services: {
        persistence: mockPersistence,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(envWithoutRegistry.services.backendRegistry).toBeUndefined()

    // When provided, it should be accessible
    const envWithRegistry: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(envWithRegistry.services.backendRegistry).toBeDefined()
    expect(envWithRegistry.services.backendRegistry).toBe(mockBackendRegistry)
  })

  test("Accepts IBackendRegistry type", () => {
    // Type-level test: IEnvironment.services.backendRegistry accepts IBackendRegistry
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }

    // Guard ensures TypeScript knows backendRegistry is defined
    const registry = env.services.backendRegistry!

    // Call IBackendRegistry methods to verify interface compatibility
    expect(typeof registry.register).toBe("function")
    expect(typeof registry.get).toBe("function")
    expect(typeof registry.has).toBe("function")
    expect(typeof registry.resolve).toBe("function")
    expect(typeof registry.setDefault).toBe("function")
  })
})

/**
 * Generated from TestSpecification: test-env-query-validator
 * Task: task-environment-extension
 * Requirement: req-06-isomorphic-execution
 */
describe("IEnvironment.services includes optional queryValidator", () => {
  test("services.queryValidator is optional property", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
        // queryValidator is NOT provided - should be valid
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.queryValidator).toBeUndefined()
  })

  test("Accepts IQueryValidator type", () => {
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
        queryValidator: mockQueryValidator,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.queryValidator).toBeDefined()
    expect(env.services.queryValidator).toBe(mockQueryValidator)

    // Call IQueryValidator method to verify interface compatibility
    if (env.services.queryValidator) {
      expect(typeof env.services.queryValidator.validateQuery).toBe("function")
    }
  })

  test("Can be omitted without type error", () => {
    // This test verifies queryValidator is truly optional by creating
    // an environment without it
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.queryValidator).toBeUndefined()
  })
})

/**
 * Generated from TestSpecification: test-env-existing-unchanged
 * Task: task-environment-extension
 * Requirement: req-06-isomorphic-execution
 */
describe("Existing persistence and auth services unchanged", () => {
  test("services.persistence still required", () => {
    // Persistence is required - this environment should be valid
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.persistence).toBeDefined()
    expect(env.services.persistence).toBe(mockPersistence)
  })

  test("services.auth still optional", () => {
    // Auth remains optional even with new services
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
        auth: mockAuthService,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.auth).toBeDefined()
    expect(env.services.auth).toBe(mockAuthService)
  })

  test("Backward compatible with existing code", () => {
    // Can still create env with only persistence (plus new required backendRegistry)
    const env: IEnvironment = {
      services: {
        persistence: mockPersistence,
        backendRegistry: mockBackendRegistry,
      },
      context: {
        schemaName: "test-schema",
      },
    }
    expect(env.services.persistence).toBeDefined()
    expect(env.services.backendRegistry).toBeDefined()
    expect(env.services.auth).toBeUndefined()
    expect(env.services.queryValidator).toBeUndefined()
  })
})
