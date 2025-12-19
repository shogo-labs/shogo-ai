/**
 * Schema Backend Wiring Tests
 *
 * Tests that global BackendRegistry is properly wired into MST environment
 * when creating runtime stores for domain schemas via schema.load.
 *
 * Key test cases:
 * - env.services.backendRegistry is set from global registry
 * - Schema with x-persistence.backend: "postgres" uses SqlQueryExecutor
 * - Schema without config uses default MemoryQueryExecutor
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { getEnv } from "mobx-state-tree"
import {
  initializePostgresBackend,
  getGlobalBackendRegistry,
  isPostgresAvailable,
  __resetForTesting,
} from "../../postgres-init"
import {
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  enhancedJsonSchemaToMST,
  FileSystemPersistence,
  createBackendRegistry,
  MemoryBackend,
  SqlBackend,
  type IEnvironment,
  type IBackendRegistry,
} from "@shogo/state-api"

// Store original env for restoration
const originalDatabaseUrl = process.env.DATABASE_URL

describe("Schema Backend Wiring", () => {
  beforeEach(() => {
    // Reset all state before each test
    resetMetaStore()
    clearRuntimeStores()
    __resetForTesting()
  })

  afterEach(() => {
    // Restore DATABASE_URL
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  describe("global backend registry singleton", () => {
    test("getGlobalBackendRegistry returns singleton with memory backend", () => {
      // Given: No DATABASE_URL set
      delete process.env.DATABASE_URL

      // When: getGlobalBackendRegistry is called
      const registry = getGlobalBackendRegistry()

      // Then: Registry has memory backend as default
      expect(registry).toBeDefined()
      expect(registry.has("memory")).toBe(true)
    })

    test("multiple calls return same registry instance", () => {
      // When: getGlobalBackendRegistry called multiple times
      const registry1 = getGlobalBackendRegistry()
      const registry2 = getGlobalBackendRegistry()

      // Then: Same instance returned
      expect(registry1).toBe(registry2)
    })

    test("registry has postgres after initialization with DATABASE_URL", () => {
      // Given: DATABASE_URL is set (skip if not available)
      if (!process.env.DATABASE_URL) {
        return // Skip test
      }

      // When: initializePostgresBackend called
      initializePostgresBackend()
      const registry = getGlobalBackendRegistry()

      // Then: Both memory and postgres backends available
      expect(registry.has("memory")).toBe(true)
      expect(registry.has("postgres")).toBe(true)
    })
  })

  describe("environment injection", () => {
    test("registry can be injected into MST environment", () => {
      // Given: A simple schema and the global backend registry
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      }

      const registry = getGlobalBackendRegistry()

      // When: Creating runtime store with registry in environment
      const { createStore } = enhancedJsonSchemaToMST(schema as any, {
        generateActions: true,
      })

      const env: IEnvironment = {
        services: {
          persistence: new FileSystemPersistence(),
          backendRegistry: registry,
        },
        context: {
          schemaName: "test-schema",
          location: "/tmp/test",
        },
      }

      const store = createStore(env)

      // Then: Environment is accessible from store with registry
      const retrievedEnv = getEnv<IEnvironment>(store)
      expect(retrievedEnv.services.backendRegistry).toBe(registry)
      expect(retrievedEnv.services.backendRegistry.has("memory")).toBe(true)
    })

    test("context.schemaName is preserved in environment", () => {
      // Given: Schema with specific name
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            },
            required: ["id"],
          },
        },
      }

      const { createStore } = enhancedJsonSchemaToMST(schema as any, {
        generateActions: true,
      })

      const env: IEnvironment = {
        services: {
          persistence: new FileSystemPersistence(),
          backendRegistry: getGlobalBackendRegistry(),
        },
        context: {
          schemaName: "my-unique-schema",
          location: "/workspace/path",
        },
      }

      // When: Creating store
      const store = createStore(env)

      // Then: Context is preserved and accessible
      const retrievedEnv = getEnv<IEnvironment>(store)
      expect(retrievedEnv.context?.schemaName).toBe("my-unique-schema")
      expect(retrievedEnv.context?.location).toBe("/workspace/path")
    })
  })

  describe("backend resolution", () => {
    test("resolve with collection returns MemoryQueryExecutor for default backend", () => {
      // Given: Schema ingested into meta-store
      const metaStore = getMetaStore()
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      }

      // Ingest schema
      metaStore.ingestEnhancedJsonSchema(schema as any, { name: "test-schema" })

      // Create a mock collection
      const mockCollection = { all: () => [] }

      // When: Resolving with collection
      const registry = getGlobalBackendRegistry()
      const executor = registry.resolve("test-schema", "Task", mockCollection)

      // Then: Returns executor (MemoryQueryExecutor for default)
      expect(executor).toBeDefined()
      expect(typeof executor.select).toBe("function")
      expect(typeof executor.first).toBe("function")
    })

    test("registry throws error when memory backend called without collection", () => {
      // Given: Schema in meta-store
      const metaStore = getMetaStore()
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            },
            required: ["id"],
          },
        },
      }

      metaStore.ingestEnhancedJsonSchema(schema as any, { name: "test-schema" })

      // When/Then: Resolve without collection throws
      const registry = getGlobalBackendRegistry()
      expect(() => {
        registry.resolve("test-schema", "Task")
      }).toThrow(/requires collection reference/)
    })
  })

  describe("postgres backend integration", () => {
    // These tests require DATABASE_URL
    const hasPostgres = !!process.env.DATABASE_URL
    const describePostgres = hasPostgres ? describe : describe.skip

    describePostgres("with DATABASE_URL", () => {
      beforeEach(() => {
        // Re-initialize postgres for each test
        __resetForTesting()
        initializePostgresBackend()
      })

      test("registry includes postgres backend after initialization", () => {
        const registry = getGlobalBackendRegistry()
        expect(registry.has("postgres")).toBe(true)
      })

      test("can resolve SQL executor without collection", () => {
        // Given: Schema with x-persistence.backend configured at model level
        const metaStore = getMetaStore()
        const schema = {
          $defs: {
            Task: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
                title: { type: "string" },
              },
              required: ["id", "title"],
              "x-persistence": {
                backend: "postgres",
                strategy: "flat",
              },
            },
          },
        }

        metaStore.ingestEnhancedJsonSchema(schema as any, { name: "postgres-schema" })

        // When: Resolving backend without collection
        const registry = getGlobalBackendRegistry()
        const executor = registry.resolve("postgres-schema", "Task")

        // Then: Returns SqlQueryExecutor (doesn't need collection)
        expect(executor).toBeDefined()
        expect(typeof executor.select).toBe("function")
        expect(typeof executor.insert).toBe("function")
      })
    })
  })
})
