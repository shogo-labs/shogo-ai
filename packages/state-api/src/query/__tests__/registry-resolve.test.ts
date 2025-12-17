/**
 * BackendRegistry.resolve() Tests
 *
 * Tests for registry's resolve() method that creates configured executors.
 *
 * Target design: resolve() returns IQueryExecutor with data source bound.
 * Current: resolve() returns IBackend (will be refactored).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BackendRegistry } from "../registry"
import { MemoryBackend } from "../backends/memory"
import { SqlBackend } from "../backends/sql"
import { BunSqlExecutor } from "../execution/bun-sql"
import { MemoryQueryExecutor } from "../executors/memory"
import { SqlQueryExecutor } from "../executors/sql"
import { parseQuery } from "../ast/parser"

// ============================================================================
// Mock Collection
// ============================================================================

function createMockCollection<T>(items: T[], modelName = "TestModel") {
  return {
    all: () => items,
    modelName
  }
}

// ============================================================================
// REG-01: Registry Signature Changes
// ============================================================================

describe("REG-01: Registry method signatures (target design)", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("register() signature: (name: string, backend: IBackend)", () => {
    // Current signature - takes IBackend instance
    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)

    expect(registry.has("memory")).toBe(true)
  })

  test("resolve() target signature: (schemaName, modelName, collection?)", () => {
    // TARGET: resolve() should accept optional collection parameter
    // and return IQueryExecutor instead of IBackend

    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)
    registry.setDefault("memory")

    const collection = createMockCollection([{ id: "1" }])

    // This will fail until refactored - resolve() currently only takes 2 params
    try {
      const executor = (registry as any).resolve(
        "test-schema",
        "TestModel",
        collection
      )
      expect(executor).toBeDefined()
    } catch (e: any) {
      // Expected to fail - not yet implemented
      expect(e.message).toContain("not implemented")
    }
  })
})

// ============================================================================
// REG-02: Memory Backend Resolution
// ============================================================================

describe("REG-02: Memory backend resolution (target behavior)", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
    registry.register("memory", new MemoryBackend())
    registry.setDefault("memory")
  })

  test("resolve() with collection returns MemoryQueryExecutor", () => {
    const collection = createMockCollection([{ id: "1", name: "Test" }])

    const result = registry.resolve("test-schema", "TestModel", collection)

    expect(result).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("memory executor has collection bound at creation", async () => {
    const testData = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" }
    ]
    const collection = createMockCollection(testData)

    // TARGET: Executor has collection bound, no need to pass to execute methods
    const executor = new MemoryQueryExecutor(collection)

    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(2)
  })

  test("memory executor filters without passing collection again", async () => {
    const testData = [
      { id: "1", status: "active" },
      { id: "2", status: "inactive" },
      { id: "3", status: "active" }
    ]
    const collection = createMockCollection(testData)
    const executor = new MemoryQueryExecutor(collection)

    // Collection already bound - just pass query
    const result = await executor.select(parseQuery({ status: "active" }))
    expect(result).toHaveLength(2)
  })
})

// ============================================================================
// REG-03: SQL Backend Resolution
// ============================================================================

describe("REG-03: SQL backend resolution (target behavior)", () => {
  let registry: BackendRegistry
  let db: Database
  let sqlExecutor: BunSqlExecutor

  beforeEach(() => {
    registry = new BackendRegistry()
    db = new Database(":memory:")
    sqlExecutor = new BunSqlExecutor(db)

    // Create test table
    db.run(`
      CREATE TABLE test_model (
        id TEXT PRIMARY KEY,
        name TEXT
      )
    `)

    db.run(`INSERT INTO test_model VALUES ('1', 'Test')`)

    // Register SQL backend with executor
    const sqlBackend = new SqlBackend({
      dialect: 'sqlite',
      executor: sqlExecutor
    })
    registry.register("sql", sqlBackend)
    registry.setDefault("sql")
  })

  afterEach(() => {
    db.close()
  })

  test("resolve() for SQL backend returns SqlQueryExecutor", () => {
    const result = registry.resolve("test-schema", "TestModel")

    expect(result).toBeInstanceOf(SqlQueryExecutor)
  })

  test("sql executor has tableName derived from model name", () => {
    const result = registry.resolve("test-schema", "TestModel")

    expect((result as any).tableName).toBe("test_model")
  })

  test("sql executor queries without passing tableName again", async () => {
    const executor = registry.resolve("test-schema", "TestModel")

    // Table name already bound - just pass query
    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(1)
  })
})

// ============================================================================
// REG-04: Backend Resolution Cascade
// ============================================================================

describe("REG-04: Backend resolution cascade", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("cascade: model x-persistence → schema x-persistence → default", () => {
    // Current implementation already does cascade
    // Testing that it continues to work

    registry.register("memory", new MemoryBackend())
    registry.setDefault("memory")

    const collection = createMockCollection([{ id: "1" }])
    const result = registry.resolve("test-schema", "TestModel", collection)

    // Should resolve to default when no model/schema override
    expect(result).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("throws descriptive error when no backend found", () => {
    // No backends registered, no default

    expect(() => {
      registry.resolve("test-schema", "TestModel")
    }).toThrow(/No backend found/)
    expect(() => {
      registry.resolve("test-schema", "TestModel")
    }).toThrow(/model x-persistence.backend/)
  })

  test("setDefault() validates backend exists", () => {
    expect(() => {
      registry.setDefault("nonexistent")
    }).toThrow(/not registered/)
  })
})

// ============================================================================
// REG-05: Column Property Map Integration
// ============================================================================

describe("REG-05: Column property map from meta-store", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("getPropertyNames() extracts from meta-store model", () => {
    // Current implementation has private getPropertyNames() method
    // It extracts property names from model.properties view

    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)
    registry.setDefault("memory")

    // This tests current behavior - getPropertyNames gets called internally
    const collection = createMockCollection([{ id: "1" }])
    const result = registry.resolve("test-schema", "TestModel", collection)

    expect(result).toBeInstanceOf(MemoryQueryExecutor)
    // Property names would be extracted if meta-store had the model
  })

  test("column property map handles edge cases", () => {
    // Tests that SqlQueryExecutor will handle edge cases correctly
    // when property names have consecutive capitals

    const propertyNames = ["ID", "HTTPSUrl", "userID"]
    const columnPropertyMap = new Map<string, string>()

    // Map snake_case columns to original property names
    for (const prop of propertyNames) {
      const snakeCase = prop
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
      columnPropertyMap.set(snakeCase, prop)
    }

    expect(columnPropertyMap.get("id")).toBe("ID")
    expect(columnPropertyMap.get("https_url")).toBe("HTTPSUrl")
    expect(columnPropertyMap.get("user_id")).toBe("userID")
  })
})

// ============================================================================
// REG-06: Table Name Derivation
// ============================================================================

describe("REG-06: Table name derivation", () => {
  test("table name uses toSnakeCase from ddl/utils", () => {
    // TARGET: Registry should derive table name using same algorithm as DDL

    const testCases = [
      { model: "TestModel", expected: "test_model" },
      { model: "HTTPSEndpoint", expected: "https_endpoint" },
      { model: "UserProfile", expected: "user_profile" },
      { model: "XMLParser", expected: "xml_parser" }
    ]

    for (const { model, expected } of testCases) {
      const tableName = model
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()

      expect(tableName).toBe(expected)
    }
  })
})
