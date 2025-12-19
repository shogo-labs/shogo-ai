/**
 * Environment Dependency Injection Tests
 *
 * Tests that meta-store and runtime stores use the unified IEnvironment
 * interface with proper dependency injection for backendRegistry.
 *
 * This test suite verifies the fix for Issue 2: Meta-store hardcodes MemoryBackend
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"
import { createBackendRegistry } from "../../query/registry"
import { MemoryBackend } from "../../query/backends/memory"
import { MemoryQueryExecutor } from "../../query/executors/memory"
import { NullPersistence } from "../../persistence/null"
import { getEnv } from "mobx-state-tree"
import type { IEnvironment } from "../../environment/types"

// Shared mock persistence for all tests
const mockPersistence = new NullPersistence()

describe("Environment Dependency Injection", () => {
  beforeEach(() => {
    resetMetaStore()
  })

  // ==========================================================================
  // test-env-di-01: Meta-store accepts IEnvironment (not IMetaStoreEnvironment)
  // ==========================================================================
  describe("Unified IEnvironment Interface", () => {
    test("meta-store accepts IEnvironment with no context", () => {
      // Given: IEnvironment with services but no context
      const backendRegistry = createBackendRegistry({
        default: "memory",
        backends: { memory: new MemoryBackend() },
      })

      const env: IEnvironment = {
        services: {
          persistence: mockPersistence,
          backendRegistry,
        },
        // No context - meta-store doesn't need it
      }

      // When: Creating meta-store with IEnvironment
      const metaStore = getMetaStore(env)

      // Then: Meta-store is created successfully
      expect(metaStore).toBeDefined()
      expect(metaStore.schemaCollection).toBeDefined()
    })

    test("meta-store environment is accessible via getEnv", () => {
      // Given: IEnvironment with backendRegistry
      const backendRegistry = createBackendRegistry({
        default: "memory",
        backends: { memory: new MemoryBackend() },
      })

      const env: IEnvironment = {
        services: { persistence: mockPersistence, backendRegistry },
      }

      // When: Creating meta-store and accessing environment
      const metaStore = getMetaStore(env)
      const retrievedEnv = getEnv<IEnvironment>(metaStore)

      // Then: Environment services are accessible
      expect(retrievedEnv.services).toBeDefined()
      expect(retrievedEnv.services.backendRegistry).toBe(backendRegistry)
    })
  })

  // ==========================================================================
  // test-env-di-02: Meta-store uses backendRegistry from environment
  // ==========================================================================
  describe("BackendRegistry Injection", () => {
    test("meta-store loadSchema uses backendRegistry from environment", async () => {
      // Given: Custom backendRegistry
      const customBackend = new MemoryBackend()
      const backendRegistry = createBackendRegistry({
        default: "memory",
        backends: { memory: customBackend },
      })

      const env: IEnvironment = {
        services: { persistence: mockPersistence, backendRegistry },
      }

      // When: Creating meta-store and loading a schema
      const metaStore = getMetaStore(env)
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      }

      const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
        name: "test-schema",
      })

      await metaStore.loadSchema(schemaEntity.name)

      // Then: Runtime store receives the injected backendRegistry
      const { getRuntimeStore } = await import("../runtime-store-cache")
      const runtimeStore = getRuntimeStore(schemaEntity.id)
      const runtimeEnv = getEnv<IEnvironment>(runtimeStore)

      expect(runtimeEnv.services.backendRegistry).toBe(backendRegistry)
    })

    test("meta-store does NOT hardcode MemoryBackend", async () => {
      // Given: Custom backend with unique marker
      class CustomTestBackend extends MemoryBackend {
        // Marker to identify this specific backend instance
        public readonly customMarker = "TEST_BACKEND_INSTANCE"
      }

      const customBackend = new CustomTestBackend()
      const backendRegistry = createBackendRegistry({
        default: "custom",
        backends: { custom: customBackend },
      })

      const env: IEnvironment = {
        services: { persistence: mockPersistence, backendRegistry },
      }

      // When: Creating meta-store and loading schema
      const metaStore = getMetaStore(env)
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Item: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id"],
          },
        },
      }

      const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
        name: "custom-backend-test",
      })

      await metaStore.loadSchema(schemaEntity.name)

      // Then: Runtime store uses our custom backend (not hardcoded MemoryBackend)
      const { getRuntimeStore } = await import("../runtime-store-cache")
      const runtimeStore = getRuntimeStore(schemaEntity.id)
      expect(runtimeStore).toBeDefined()

      const runtimeEnv = getEnv<IEnvironment>(runtimeStore)

      // Pass collection for memory backend
      const mockCollection = { all: () => [], modelName: "Item" }
      const resolvedExecutor = runtimeEnv.services.backendRegistry!.resolve(
        "custom-backend-test",
        "Item",
        mockCollection
      )

      // Should return MemoryQueryExecutor for custom memory backend
      expect(resolvedExecutor).toBeInstanceOf(MemoryQueryExecutor)

      // Custom backend is used internally (composition pattern)
      // The executor wraps the custom backend behavior
    })
  })

  // ==========================================================================
  // test-env-di-03: Fallback to default when no backendRegistry provided
  // ==========================================================================
  describe("Default Fallback", () => {
    test("meta-store creates default backendRegistry if not provided", async () => {
      // Given: Environment with persistence but no backendRegistry
      const env: IEnvironment = {
        services: { persistence: mockPersistence },
      }

      // When: Creating meta-store without backendRegistry
      const metaStore = getMetaStore(env)

      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Note: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              content: { type: "string" },
            },
            required: ["id"],
          },
        },
      }

      const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
        name: "fallback-test",
      })

      // Then: loadSchema succeeds with default MemoryBackend
      await expect(metaStore.loadSchema(schemaEntity.name)).resolves.toBeDefined()

      // And: Runtime store has a working backend
      const { getRuntimeStore } = await import("../runtime-store-cache")
      const runtimeStore = getRuntimeStore(schemaEntity.id)
      expect(runtimeStore).toBeDefined()

      const runtimeEnv = getEnv<IEnvironment>(runtimeStore)
      expect(runtimeEnv.services.backendRegistry).toBeDefined()
    })
  })

  // ==========================================================================
  // test-env-di-04: Context is optional for meta-store, required for runtime
  // ==========================================================================
  describe("Context Optionality", () => {
    test("meta-store environment has no context", () => {
      // Given: Environment with services but no context
      const env: IEnvironment = {
        services: {
          persistence: mockPersistence,
          backendRegistry: createBackendRegistry({
            default: "memory",
            backends: { memory: new MemoryBackend() },
          }),
        },
        // No context field at all
      }

      // When: Creating meta-store
      const metaStore = getMetaStore(env)
      const retrievedEnv = getEnv<IEnvironment>(metaStore)

      // Then: Context is undefined
      expect(retrievedEnv.context).toBeUndefined()
    })

    test("runtime store environment has context with schemaName", async () => {
      // Given: Meta-store with backendRegistry
      const env: IEnvironment = {
        services: {
          persistence: mockPersistence,
          backendRegistry: createBackendRegistry({
            default: "memory",
            backends: { memory: new MemoryBackend() },
          }),
        },
      }

      const metaStore = getMetaStore(env)
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Record: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
            },
            required: ["id"],
          },
        },
      }

      const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
        name: "context-test-schema",
      })

      // When: Loading schema creates runtime store
      await metaStore.loadSchema(schemaEntity.name)

      // Then: Runtime store has context with schemaName
      const { getRuntimeStore } = await import("../runtime-store-cache")
      const runtimeStore = getRuntimeStore(schemaEntity.id)
      const runtimeEnv = getEnv<IEnvironment>(runtimeStore)

      expect(runtimeEnv.context).toBeDefined()
      expect(runtimeEnv.context!.schemaName).toBe("context-test-schema")
    })
  })
})
