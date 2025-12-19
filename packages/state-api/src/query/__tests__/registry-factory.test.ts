/**
 * Registry Factory Pattern Tests
 *
 * Tests for BackendRegistry support of backends with createExecutor factory method.
 * This enables remote backends (like MCPBackend) to create custom executors.
 *
 * TDD RED Tests - Written before implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  createBackendRegistry,
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  MemoryBackend,
  SqlBackend,
  NullPersistence,
} from "../../index"
// Server-only executor - import directly to avoid browser bundle bloat
import { BunSqlExecutor } from "../execution/bun-sql"
import { Database } from "bun:sqlite"
import type { IBackend, BackendCapabilities } from "../backends/types"
import type { IQueryExecutor } from "../executors/types"
import type { Condition } from "../ast/types"
import type { IEnvironment } from "../../environment/types"

// =============================================================================
// Mock Backend with createExecutor Factory
// =============================================================================

/**
 * Mock executor returned by the factory
 */
class MockRemoteExecutor<T> implements IQueryExecutor<T> {
  readonly executorType = "remote" as const

  constructor(
    public readonly schemaName: string,
    public readonly modelName: string,
    public readonly collection: any
  ) {}

  async select(condition: Condition): Promise<T[]> {
    return []
  }

  async first(condition: Condition): Promise<T | undefined> {
    return undefined
  }

  async count(condition: Condition): Promise<number> {
    return 0
  }

  async exists(condition: Condition): Promise<boolean> {
    return false
  }

  async insert(entity: T): Promise<T> {
    return entity
  }

  async update(id: string, changes: Partial<T>): Promise<T | undefined> {
    return undefined
  }

  async delete(id: string): Promise<boolean> {
    return true
  }

  async insertMany(entities: T[]): Promise<T[]> {
    return entities
  }

  async updateMany(condition: Condition, changes: Partial<T>): Promise<number> {
    return 0
  }

  async deleteMany(condition: Condition): Promise<number> {
    return 0
  }
}

/**
 * Mock backend with createExecutor factory method.
 * Simulates what MCPBackend will do.
 */
class MockRemoteBackend implements IBackend {
  readonly capabilities: BackendCapabilities = {
    operators: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "and", "or"],
    features: { sorting: true, pagination: true, relations: false },
  }

  // No dialect property - this distinguishes it from SqlBackend

  createExecutor<T>(
    schemaName: string,
    modelName: string,
    collection: any
  ): IQueryExecutor<T> {
    return new MockRemoteExecutor<T>(schemaName, modelName, collection)
  }

  // Required by IBackend but not used directly
  async execute<T>(): Promise<{ items: T[]; count: number }> {
    throw new Error("Use createExecutor() instead")
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("BackendRegistry with createExecutor factory", () => {
  let testEnv: IEnvironment

  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()

    testEnv = {
      services: {
        persistence: new NullPersistence(),
        backendRegistry: createBackendRegistry(),
      },
    }

    const metaStore = getMetaStore(testEnv)

    // Ingest a test schema
    metaStore.ingestEnhancedJsonSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Task: {
            type: "object",
            "x-persistence": {
              strategy: "flat",
              backend: "remote",
            },
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      },
      { name: "test-schema" }
    )
  })

  afterEach(() => {
    clearRuntimeStores()
    resetMetaStore()
  })

  test("resolve() returns factory-created executor when backend has createExecutor", () => {
    // Given: Backend with createExecutor factory method
    const remoteBackend = new MockRemoteBackend()
    const registry = createBackendRegistry({
      default: "remote",
      backends: { remote: remoteBackend },
    })

    // When: resolve() is called
    const mockCollection = { items: new Map() }
    const executor = registry.resolve("test-schema", "Task", mockCollection)

    // Then: Returns executor created by factory
    expect(executor).toBeInstanceOf(MockRemoteExecutor)
    expect(executor.executorType).toBe("remote")
  })

  test("factory receives schemaName, modelName, collection params", () => {
    // Given: Backend with createExecutor factory
    const remoteBackend = new MockRemoteBackend()
    const registry = createBackendRegistry({
      default: "remote",
      backends: { remote: remoteBackend },
    })

    // When: resolve() is called with specific params
    const mockCollection = { items: new Map(), testMarker: "collection-123" }
    const executor = registry.resolve(
      "test-schema",
      "Task",
      mockCollection
    ) as MockRemoteExecutor<any>

    // Then: Factory received correct parameters
    expect(executor.schemaName).toBe("test-schema")
    expect(executor.modelName).toBe("Task")
    expect(executor.collection).toBe(mockCollection)
    expect(executor.collection.testMarker).toBe("collection-123")
  })

  test("dialect backends still create SqlQueryExecutor", () => {
    // Given: SqlBackend with dialect property
    const testDb = new Database(":memory:")
    testDb.run(`CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT)`)

    const executor = new BunSqlExecutor(testDb)
    const sqlBackend = new SqlBackend({ dialect: "sqlite", executor })
    const registry = createBackendRegistry({
      default: "sql",
      backends: { sql: sqlBackend },
    })

    // Update schema to use sql backend
    resetMetaStore()
    const metaStore = getMetaStore(testEnv)
    metaStore.ingestEnhancedJsonSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Task: {
            type: "object",
            "x-persistence": { strategy: "flat", backend: "sql" },
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      },
      { name: "test-schema" }
    )

    // When: resolve() is called
    const result = registry.resolve("test-schema", "Task")

    // Then: Returns SqlQueryExecutor (not factory-created)
    expect(result.executorType).toBe("remote") // SqlQueryExecutor has 'remote' type
    expect(result).not.toBeInstanceOf(MockRemoteExecutor)

    testDb.close()
  })

  test("plain backends still create MemoryQueryExecutor", () => {
    // Given: MemoryBackend (no dialect, no createExecutor)
    const memoryBackend = new MemoryBackend()
    const registry = createBackendRegistry({
      default: "memory",
      backends: { memory: memoryBackend },
    })

    // Update schema to use memory backend
    resetMetaStore()
    const metaStore = getMetaStore(testEnv)
    metaStore.ingestEnhancedJsonSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Task: {
            type: "object",
            "x-persistence": { strategy: "flat", backend: "memory" },
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      },
      { name: "test-schema" }
    )

    // When: resolve() is called with collection
    const mockCollection = {
      all: () => [],
      items: new Map(),
    }
    const result = registry.resolve("test-schema", "Task", mockCollection)

    // Then: Returns MemoryQueryExecutor
    expect(result.executorType).toBe("local") // MemoryQueryExecutor uses "local"
    expect(result).not.toBeInstanceOf(MockRemoteExecutor)
  })

  test("createExecutor takes precedence over memory fallback", () => {
    // Given: Backend with both no-dialect AND createExecutor
    // (createExecutor should be preferred over treating it as memory backend)
    const remoteBackend = new MockRemoteBackend()
    const registry = createBackendRegistry({
      default: "remote",
      backends: { remote: remoteBackend },
    })

    // When: resolve() is called
    const mockCollection = { items: new Map() }
    const executor = registry.resolve("test-schema", "Task", mockCollection)

    // Then: createExecutor is used, not MemoryQueryExecutor
    expect(executor).toBeInstanceOf(MockRemoteExecutor)
    expect(executor.executorType).toBe("remote")
  })
})
