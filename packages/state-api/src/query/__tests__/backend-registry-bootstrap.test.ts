/**
 * Backend Registry Bootstrap Tests
 *
 * Generated from TestSpecifications for task-mig-007-bootstrap.
 * Tests x-persistence.bootstrap flag handling in BackendRegistry.
 *
 * Requirements:
 * - REQ-DDL-MIG-009: Bootstrap schema auto-DDL during initialization
 * - REQ-DDL-MIG-008: Backwards compatibility for non-bootstrap schemas
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { IBackend, DDLExecutionResult } from "../backends/types"
import { resetMetaStore, getMetaStore, clearRuntimeStores } from "../../meta/bootstrap"
import { BackendRegistry, createBackendRegistry } from "../registry"

// Mock SQL backend that tracks DDL execution calls
function createMockSqlBackend() {
  const executeDDLCalls: Array<{ schema: any; options?: any }> = []

  const backend: IBackend = {
    dialect: "sqlite" as const,
    executor: {
      execute: mock(() => Promise.resolve([] as any)),
      executeMany: mock(() => Promise.resolve(0)),
      beginTransaction: mock(async <T>(callback: (tx: any) => Promise<T>) => callback({ execute: mock(() => Promise.resolve([])) })),
    } as any,
    capabilities: {
      operators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
      features: { sorting: true, pagination: true, relations: true },
    },
    async execute<T>(ast: any, collection: T[], options?: any) {
      return { items: collection }
    },
    async executeDDL(schema: any, options?: any): Promise<DDLExecutionResult> {
      executeDDLCalls.push({ schema, options })
      return { success: true, statements: ["CREATE TABLE ..."], executed: 1 }
    },
  }

  return { backend, executeDDLCalls }
}

// Test schemas
const systemMigrationsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "system-migrations",
  "x-persistence": {
    bootstrap: true,
    backend: "sql",
  },
  $defs: {
    MigrationRecord: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        schemaName: { type: "string" },
        version: { type: "integer" },
      },
      required: ["id", "schemaName", "version"],
    },
  },
}

const anotherBootstrapSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "another-bootstrap",
  "x-persistence": {
    bootstrap: true,
    backend: "sql",
  },
  $defs: {
    SomeEntity: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
      },
      required: ["id"],
    },
  },
}

const userSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "user-schema",
  "x-persistence": {
    backend: "sql",
  },
  $defs: {
    User: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        email: { type: "string" },
      },
      required: ["id", "email"],
    },
  },
}

describe("BackendRegistry Bootstrap", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  describe("BackendRegistry detects bootstrap schemas", () => {
    test("getBootstrapSchemas returns schemas with x-persistence.bootstrap: true", () => {
      // Given: Schemas ingested
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })

      // When: getBootstrapSchemas is called
      const registry = new BackendRegistry()
      const bootstrapSchemas = registry.getBootstrapSchemas()

      // Then: Only system-migrations is returned
      expect(bootstrapSchemas).toContain("system-migrations")
      expect(bootstrapSchemas).not.toContain("user-schema")
    })

    test("getBootstrapSchemas returns all bootstrap schemas", () => {
      // Given: Multiple bootstrap schemas
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(anotherBootstrapSchema, { name: "another-bootstrap" })
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })

      // When: getBootstrapSchemas is called
      const registry = new BackendRegistry()
      const bootstrapSchemas = registry.getBootstrapSchemas()

      // Then: Both bootstrap schemas returned
      expect(bootstrapSchemas).toContain("system-migrations")
      expect(bootstrapSchemas).toContain("another-bootstrap")
      expect(bootstrapSchemas).not.toContain("user-schema")
    })
  })

  describe("Bootstrap DDL executes during registry initialization", () => {
    test("initialize() executes DDL for bootstrap schemas", async () => {
      // Given: Bootstrap schema ingested and mock backend
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() is called
      await registry.initialize()

      // Then: DDL executed for system-migrations
      expect(executeDDLCalls.length).toBe(1)
      expect(executeDDLCalls[0].schema.$id).toBe("system-migrations")
    })

    test("initialize() uses ifNotExists for idempotency", async () => {
      // Given: Bootstrap schema ingested
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() is called
      await registry.initialize()

      // Then: Options include ifNotExists: true
      expect(executeDDLCalls[0].options?.ifNotExists).toBe(true)
    })
  })

  describe("Bootstrap DDL runs before other schema operations", () => {
    test("DDL order: bootstrap first, then user schema", async () => {
      // Given: Both bootstrap and user schema ingested
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() then executeDDL for user schema
      await registry.initialize()
      await registry.executeDDL("user-schema", userSchema)

      // Then: Bootstrap DDL executed first
      expect(executeDDLCalls.length).toBe(2)
      expect(executeDDLCalls[0].schema.$id).toBe("system-migrations")
      expect(executeDDLCalls[1].schema.$id).toBe("user-schema")
    })
  })

  describe("Multiple bootstrap schemas supported", () => {
    test("initialize() executes DDL for all bootstrap schemas", async () => {
      // Given: Multiple bootstrap schemas
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(anotherBootstrapSchema, { name: "another-bootstrap" })
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() is called
      await registry.initialize()

      // Then: Both bootstrap schemas have DDL executed
      expect(executeDDLCalls.length).toBe(2)
      const schemaIds = executeDDLCalls.map((c) => c.schema.$id)
      expect(schemaIds).toContain("system-migrations")
      expect(schemaIds).toContain("another-bootstrap")
    })

    test("user schema DDL not executed during initialization", async () => {
      // Given: Bootstrap and user schemas
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() is called
      await registry.initialize()

      // Then: Only bootstrap schema DDL executed
      const schemaIds = executeDDLCalls.map((c) => c.schema.$id)
      expect(schemaIds).not.toContain("user-schema")
    })
  })

  describe("Non-bootstrap schemas unaffected", () => {
    test("existing behavior preserved for non-bootstrap schemas", async () => {
      // Given: Only user schema (no bootstrap)
      getMetaStore().ingestEnhancedJsonSchema(userSchema, { name: "user-schema" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() is called
      await registry.initialize()

      // Then: No DDL executed during initialization
      expect(executeDDLCalls.length).toBe(0)

      // And: executeDDL works normally
      await registry.executeDDL("user-schema", userSchema)
      expect(executeDDLCalls.length).toBe(1)
    })
  })

  describe("Bootstrap DDL error handling", () => {
    test("error during bootstrap DDL is logged and propagated", async () => {
      // Given: Bootstrap schema and failing backend
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })

      const failingBackend: IBackend = {
        dialect: "sqlite" as const,
        executor: {
          execute: mock(() => Promise.reject(new Error("Connection failed"))),
          beginTransaction: mock(async <T>(callback: (tx: any) => Promise<T>) => callback({ execute: mock(() => Promise.resolve([])) })),
        } as any,
        capabilities: {
          operators: [],
          features: { sorting: false, pagination: false, relations: false },
        },
        async execute() {
          return { items: [] }
        },
        async executeDDL(): Promise<DDLExecutionResult> {
          throw new Error("Connection failed")
        },
      }

      const registry = new BackendRegistry()
      registry.register("sql", failingBackend)
      registry.setDefault("sql")

      // When/Then: initialize() rejects with error
      await expect(registry.initialize()).rejects.toThrow("Connection failed")
    })

    test("partial success scenario - later bootstrap schema can fail", async () => {
      // Given: Two bootstrap schemas, second one fails
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      getMetaStore().ingestEnhancedJsonSchema(anotherBootstrapSchema, { name: "another-bootstrap" })

      let callCount = 0
      const partialFailBackend: IBackend = {
        dialect: "sqlite" as const,
        executor: {
          execute: mock(() => Promise.resolve([] as any)),
          beginTransaction: mock(async <T>(callback: (tx: any) => Promise<T>) => callback({ execute: mock(() => Promise.resolve([])) })),
        } as any,
        capabilities: {
          operators: [],
          features: { sorting: false, pagination: false, relations: false },
        },
        async execute() {
          return { items: [] }
        },
        async executeDDL(): Promise<DDLExecutionResult> {
          callCount++
          if (callCount > 1) {
            throw new Error("Second schema failed")
          }
          return { success: true, statements: [], executed: 0 }
        },
      }

      const registry = new BackendRegistry()
      registry.register("sql", partialFailBackend)
      registry.setDefault("sql")

      // When/Then: initialize() fails on second schema
      await expect(registry.initialize()).rejects.toThrow("Second schema failed")
    })
  })

  describe("Initialize idempotency", () => {
    test("initialize() can be called multiple times safely", async () => {
      // Given: Bootstrap schema with tracking
      getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })
      const { backend, executeDDLCalls } = createMockSqlBackend()

      const registry = new BackendRegistry()
      registry.register("sql", backend)
      registry.setDefault("sql")

      // When: initialize() called twice
      await registry.initialize()
      await registry.initialize()

      // Then: DDL executed twice (ifNotExists makes this safe)
      expect(executeDDLCalls.length).toBe(2)
    })
  })
})
