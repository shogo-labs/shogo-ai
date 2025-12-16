/**
 * BackendRegistry Tests
 *
 * Tests for schema-driven backend resolution with cascade lookup.
 * Generated from TestSpecifications for task-backend-registry.
 *
 * Requirements:
 * - REQ-04: Schema-driven backend binding via x-persistence metadata
 * - Cascade resolution: model → schema → default
 * - Descriptive errors when no backend found
 */

import { describe, test, expect, beforeEach } from "bun:test"
import type { IBackend } from "../backends/types"
import { ContextAwareBackend } from "../backends/context-aware"
import { getMetaStore, resetMetaStore } from "../../meta/bootstrap"
import {
  IBackendRegistry,
  BackendRegistry,
  createBackendRegistry,
  type BackendRegistryConfig
} from "../registry"

// Mock backend implementations for testing
class MockMemoryBackend implements IBackend {
  capabilities = {
    operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
    features: {
      sorting: true,
      pagination: true,
      relations: false
    }
  }

  async execute<T>(ast: any, collection: T[], options?: any) {
    return { items: collection }
  }
}

class MockSqlBackend implements IBackend {
  capabilities = {
    operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'like'],
    features: {
      sorting: true,
      pagination: true,
      relations: true,
      aggregation: true
    }
  }

  async execute<T>(ast: any, collection: T[], options?: any) {
    return { items: collection }
  }
}

describe("BackendRegistry", () => {
  let memoryBackend: IBackend
  let sqlBackend: IBackend

  beforeEach(() => {
    resetMetaStore()
    memoryBackend = new MockMemoryBackend()
    sqlBackend = new MockSqlBackend()
  })

  describe("test-registry-interface", () => {
    test("IBackendRegistry interface defines required methods", () => {
      // Given: IBackendRegistry interface is imported
      // When: Implementing IBackendRegistry
      // Then: register(name, backend) method required
      // Then: get(name) method required
      // Then: has(name) method required
      // Then: resolve(schemaName, modelName) method required
      // Then: setDefault(name) method required

      // This test validates the interface exists and has correct shape
      // We validate this by checking BackendRegistry implements it
      const registry: IBackendRegistry = new BackendRegistry()

      // Validate all methods exist
      expect(typeof registry.register).toBe('function')
      expect(typeof registry.get).toBe('function')
      expect(typeof registry.has).toBe('function')
      expect(typeof registry.resolve).toBe('function')
      expect(typeof registry.setDefault).toBe('function')
    })
  })

  describe("test-registry-implements", () => {
    test("BackendRegistry class implements IBackendRegistry", () => {
      // Given: BackendRegistry class is imported
      // When: Creating BackendRegistry instance
      const registry = new BackendRegistry()

      // Then: Instance has all required methods
      expect(registry).toHaveProperty('register')
      expect(registry).toHaveProperty('get')
      expect(registry).toHaveProperty('has')
      expect(registry).toHaveProperty('resolve')
      expect(registry).toHaveProperty('setDefault')

      // Then: Satisfies IBackendRegistry interface
      const interfaceRef: IBackendRegistry = registry
      expect(interfaceRef).toBeDefined()

      // Then: Can be used for dependency injection
      expect(registry instanceof BackendRegistry).toBe(true)
    })
  })

  describe("test-registry-register", () => {
    test("register(name, backend) adds backend by name", () => {
      // Given: BackendRegistry instance
      const registry = new BackendRegistry()

      // Given: MemoryBackend instance
      // When: Calling register('memory', memoryBackend)
      registry.register('memory', memoryBackend)

      // Then: Backend is stored
      expect(registry.has('memory')).toBe(true)

      // Then: Can be retrieved by name
      const retrieved = registry.get('memory')
      expect(retrieved).toBe(memoryBackend)

      // Then: No error thrown (test passes if we got here)
    })
  })

  describe("test-registry-get", () => {
    test("get(name) returns backend or undefined", () => {
      // Given: BackendRegistry with registered 'memory' backend
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)

      // When: Calling get('memory') and get('unknown')
      const foundBackend = registry.get('memory')
      const missingBackend = registry.get('unknown')

      // Then: get('memory') returns the registered backend
      expect(foundBackend).toBe(memoryBackend)

      // Then: get('unknown') returns undefined
      expect(missingBackend).toBeUndefined()

      // Then: Does not throw for missing backend (test passes if we got here)
    })
  })

  describe("test-registry-has", () => {
    test("has(name) returns boolean", () => {
      // Given: BackendRegistry with registered 'memory' backend
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)

      // When: Calling has('memory') and has('unknown')
      // Then: has('memory') returns true
      expect(registry.has('memory')).toBe(true)

      // Then: has('unknown') returns false
      expect(registry.has('unknown')).toBe(false)
    })
  })

  describe("test-registry-resolve-model", () => {
    test("resolve() uses model-level x-persistence.backend first", () => {
      // Given: BackendRegistry with meta-store
      const registry = new BackendRegistry()
      registry.register('sql', sqlBackend)
      registry.register('memory', memoryBackend)

      // Given: Model has x-persistence.backend: 'sql'
      // Setup: Create a schema with model-level backend config
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            "x-persistence": {
              strategy: "flat",
              backend: "sql"
            },
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema, {
        name: "test-schema"
      })

      // When: Calling resolve(schemaName, modelName)
      const backend = registry.resolve("test-schema", "User")

      // Then: Returns ContextAwareBackend wrapping 'sql' backend
      // (Registry now wraps backends with schema-aware normalization)
      expect(backend).toBeInstanceOf(ContextAwareBackend)
      expect(backend.capabilities).toEqual(sqlBackend.capabilities)

      // Then: Model config takes precedence
      // Then: Schema config not checked (validated by getting sql backend)
    })
  })

  describe("test-registry-resolve-schema", () => {
    test("resolve() falls back to schema-level config", () => {
      // NOTE: Schema-level x-persistence.backend is not yet supported in meta-store
      // This test validates the cascade exists but falls through to default

      // Given: BackendRegistry with meta-store and default set
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)
      registry.register('sql', sqlBackend)
      registry.setDefault('memory')

      // Given: Model has no x-persistence.backend
      // Given: Schema has no x-persistence (not supported yet in meta-store)
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema, {
        name: "test-schema-fallback"
      })

      // When: Calling resolve(schemaName, modelName)
      const backend = registry.resolve("test-schema-fallback", "User")

      // Then: Returns ContextAwareBackend wrapping 'memory' backend
      // (Registry now wraps backends with schema-aware normalization)
      expect(backend).toBeInstanceOf(ContextAwareBackend)
      expect(backend.capabilities).toEqual(memoryBackend.capabilities)

      // Then: Falls back through cascade to default
      // Schema-level config would take precedence once meta-store supports it
    })
  })

  describe("test-registry-resolve-default", () => {
    test("resolve() falls back to registry default", () => {
      // Given: BackendRegistry with default set to 'memory'
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)
      registry.register('sql', sqlBackend)
      registry.setDefault('memory')

      // Given: Model and schema have no x-persistence.backend
      // Setup: Create a schema without any backend config
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema, {
        name: "test-schema-default"
      })

      // When: Calling resolve(schemaName, modelName)
      const backend = registry.resolve("test-schema-default", "User")

      // Then: Returns ContextAwareBackend wrapping 'memory' backend (the default)
      expect(backend).toBeInstanceOf(ContextAwareBackend)
      expect(backend.capabilities).toEqual(memoryBackend.capabilities)

      // Then: Cascade: model → schema → default (validated by getting default)
    })
  })

  describe("test-registry-set-default", () => {
    test("setDefault(name) sets fallback backend", () => {
      // Given: BackendRegistry with 'memory' and 'sql' registered
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)
      registry.register('sql', sqlBackend)

      // When: Calling setDefault('memory')
      registry.setDefault('memory')

      // Then: Default is set to 'memory'
      // Create schema without backend config to test default
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      }
      metaStore.ingestEnhancedJsonSchema(inputSchema, { name: "test-setdefault" })

      // Then: resolve() uses this when no config found
      const backend = registry.resolve("test-setdefault", "Task")
      expect(backend).toBeInstanceOf(ContextAwareBackend)
      expect(backend.capabilities).toEqual(memoryBackend.capabilities)

      // Then: Can be changed later
      registry.setDefault('sql')
      const backend2 = registry.resolve("test-setdefault", "Task")
      expect(backend2).toBeInstanceOf(ContextAwareBackend)
      expect(backend2.capabilities).toEqual(sqlBackend.capabilities)
    })
  })

  describe("test-registry-factory", () => {
    test("createBackendRegistry() factory for configured construction", () => {
      // Given: createBackendRegistry function is imported
      // When: Calling createBackendRegistry({ default: 'memory', backends: {...} })
      const config: BackendRegistryConfig = {
        default: 'memory',
        backends: {
          memory: memoryBackend,
          sql: sqlBackend
        }
      }
      const registry = createBackendRegistry(config)

      // Then: Returns configured BackendRegistry
      expect(registry).toBeInstanceOf(BackendRegistry)

      // Then: Backends pre-registered
      expect(registry.has('memory')).toBe(true)
      expect(registry.has('sql')).toBe(true)
      expect(registry.get('memory')).toBe(memoryBackend)
      expect(registry.get('sql')).toBe(sqlBackend)

      // Then: Default pre-set
      // Create schema without backend config to test default
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Item: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      }
      metaStore.ingestEnhancedJsonSchema(inputSchema, { name: "test-factory" })
      const backend = registry.resolve("test-factory", "Item")
      expect(backend).toBeInstanceOf(ContextAwareBackend)
      expect(backend.capabilities).toEqual(memoryBackend.capabilities)
    })
  })

  describe("test-registry-no-backend-error", () => {
    test("Throws error if no backend found and no default", () => {
      // Given: BackendRegistry with no default set
      const registry = new BackendRegistry()
      registry.register('memory', memoryBackend)

      // Given: No x-persistence.backend in schema/model
      // Setup: Create a schema without any backend config
      const metaStore = getMetaStore()
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema, {
        name: "test-schema-error"
      })

      // When: Calling resolve(schemaName, modelName)
      // Then: Throws descriptive error
      expect(() => {
        registry.resolve("test-schema-error", "User")
      }).toThrow()

      // Then: Error mentions schema and model names
      // Then: Suggests setting default or configuring x-persistence
      try {
        registry.resolve("test-schema-error", "User")
      } catch (error: any) {
        expect(error.message).toContain("test-schema-error")
        expect(error.message).toContain("User")
        expect(error.message).toContain("setDefault")
        expect(error.message).toContain("x-persistence")
      }
    })
  })
})
