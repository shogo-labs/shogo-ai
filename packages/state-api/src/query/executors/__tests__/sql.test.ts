/**
 * SqlQueryExecutor Tests
 *
 * Tests for SQL query executor implementation.
 * Validates compilation, execution, and bidirectional field name normalization.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { parseQuery } from "../../ast/parser"
import { SqlBackend } from "../../backends/sql"
import { BunSqlExecutor } from "../../execution/bun-sql"
import { SqlQueryExecutor } from "../sql"
import { createColumnPropertyMap } from "../../execution/utils"
import { testExecutorContract } from "./interface.test"

// ============================================================================
// SQL-01: SqlQueryExecutor Implementation Tests
// ============================================================================

describe("SQL-01: SqlQueryExecutor", () => {
  type TestEntity = {
    id: string
    userId: string
    createdAt: number
    isActive: boolean
  }

  let db: Database
  let executor: SqlQueryExecutor<TestEntity>

  beforeEach(() => {
    // Setup SQLite database
    db = new Database(":memory:")

    // Create table with snake_case columns (as DDL would generate)
    db.run(`
      CREATE TABLE test_model (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_active INTEGER NOT NULL
      )
    `)

    // Seed test data
    db.run(`
      INSERT INTO test_model (id, user_id, created_at, is_active) VALUES
      ('1', 'alice', 1000, 1),
      ('2', 'bob', 2000, 0),
      ('3', 'charlie', 3000, 1)
    `)

    // Create executor with property map for normalization
    const propertyNames = ["id", "userId", "createdAt", "isActive"]
    const columnPropertyMap = createColumnPropertyMap(propertyNames)
    const propertyTypes = {
      id: "string",
      userId: "string",
      createdAt: "number",
      isActive: "boolean"
    }

    executor = new SqlQueryExecutor(
      "test_model",
      new SqlBackend("sqlite"),  // SQLite dialect
      new BunSqlExecutor(db),
      columnPropertyMap,
      "sqlite",
      propertyTypes
    )
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // Construction and Dependencies
  // ==========================================================================

  test("constructor binds all dependencies", () => {
    expect(executor).toBeDefined()
    // All dependencies bound - no need to pass them to methods
  })

  test("executorType is 'remote'", () => {
    expect(executor.executorType).toBe('remote')
  })

  // ==========================================================================
  // Basic Query Execution
  // ==========================================================================

  test("select() with empty filter returns all rows", async () => {
    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(3)
  })

  test("select() compiles and executes SQL query", async () => {
    const result = await executor.select(parseQuery({ userId: "alice" }))
    expect(result).toHaveLength(1)
    expect(result[0].userId).toBe("alice")
  })

  // ==========================================================================
  // Input Normalization (camelCase → snake_case)
  // ==========================================================================

  test("WHERE clause converts camelCase field to snake_case", async () => {
    // Query with camelCase field name
    const result = await executor.select(parseQuery({ userId: "bob" }))

    expect(result).toHaveLength(1)
    expect(result[0].userId).toBe("bob")
    // Internally should have queried: WHERE user_id = 'bob'
  })

  test("orderBy converts camelCase field to snake_case", async () => {
    // Order by camelCase field name
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "createdAt", direction: "desc" }
    })

    expect(result.map(r => r.userId)).toEqual(["charlie", "bob", "alice"])
    // Internally should have generated: ORDER BY created_at DESC
  })

  test("multiple camelCase fields in WHERE", async () => {
    const result = await executor.select(
      parseQuery({ userId: "alice", isActive: true })
    )

    expect(result).toHaveLength(1)
    expect(result[0].userId).toBe("alice")
    expect(result[0].isActive).toBe(true)
  })

  // ==========================================================================
  // Output Normalization (snake_case → camelCase)
  // ==========================================================================

  test("results have camelCase property names", async () => {
    const result = await executor.select(parseQuery({}))

    expect(result[0]).toHaveProperty("userId")
    expect(result[0]).toHaveProperty("createdAt")
    expect(result[0]).toHaveProperty("isActive")

    // Should NOT have snake_case names
    expect(result[0]).not.toHaveProperty("user_id")
    expect(result[0]).not.toHaveProperty("created_at")
    expect(result[0]).not.toHaveProperty("is_active")
  })

  test("boolean values normalized correctly", async () => {
    const result = await executor.select(parseQuery({ id: "1" }))

    // SQLite stores boolean as INTEGER (1/0)
    // Should be normalized to boolean
    expect(result[0].isActive).toBe(true)
    expect(typeof result[0].isActive).toBe("boolean")
  })

  // ==========================================================================
  // Round-Trip Normalization
  // ==========================================================================

  test("round-trip: query with camelCase, get results in camelCase", async () => {
    const result = await executor.select(
      parseQuery({ userId: "alice", isActive: true }),
      { orderBy: { field: "createdAt", direction: "asc" } }
    )

    // All field names should be camelCase throughout
    expect(result).toHaveLength(1)
    expect(result[0].userId).toBe("alice")
    expect(result[0].createdAt).toBe(1000)
    expect(result[0].isActive).toBe(true)
  })

  // ==========================================================================
  // Pagination
  // ==========================================================================

  test("select() applies LIMIT", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "id", direction: "asc" },
      take: 2
    })

    expect(result).toHaveLength(2)
    expect(result.map(r => r.id)).toEqual(["1", "2"])
  })

  test("select() applies OFFSET", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "id", direction: "asc" },
      skip: 1
    })

    expect(result).toHaveLength(2)
    expect(result.map(r => r.id)).toEqual(["2", "3"])
  })

  test("select() applies LIMIT and OFFSET together", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "id", direction: "asc" },
      skip: 1,
      take: 1
    })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("2")
  })

  // ==========================================================================
  // Terminal Operations
  // ==========================================================================

  test("first() uses LIMIT 1 optimization", async () => {
    const result = await executor.first(parseQuery({ userId: "alice" }))

    expect(result).toBeDefined()
    expect(result?.userId).toBe("alice")
  })

  test("first() returns undefined when no matches", async () => {
    const result = await executor.first(parseQuery({ userId: "david" }))

    expect(result).toBeUndefined()
  })

  test("count() uses SQL COUNT(*)", async () => {
    const result = await executor.count(parseQuery({ isActive: true }))

    expect(result).toBe(2)
    // Should NOT fetch all rows - uses COUNT(*)
  })

  test("count() with no matches returns 0", async () => {
    const result = await executor.count(parseQuery({ userId: "david" }))

    expect(result).toBe(0)
  })

  test("exists() returns true when matches exist", async () => {
    const result = await executor.exists(parseQuery({ userId: "alice" }))

    expect(result).toBe(true)
  })

  test("exists() returns false when no matches", async () => {
    const result = await executor.exists(parseQuery({ userId: "david" }))

    expect(result).toBe(false)
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  test("empty WHERE clause handled correctly", async () => {
    // parseQuery({}) creates empty AND condition
    const result = await executor.select(parseQuery({}))

    expect(result).toHaveLength(3)
    // Should generate: SELECT * FROM test_model (no WHERE clause)
  })

  test("handles comparison operators with normalization", async () => {
    const result = await executor.select(
      parseQuery({ createdAt: { $gt: 1500 } })
    )

    expect(result).toHaveLength(2)
    expect(result.map(r => r.userId)).toContain("bob")
    expect(result.map(r => r.userId)).toContain("charlie")
  })
})

// ============================================================================
// SQL-02: Edge Case Field Name Normalization
// ============================================================================

describe("SQL-02: Edge Case Field Names", () => {
  let db: Database
  let executor: SqlQueryExecutor<any>

  beforeEach(() => {
    db = new Database(":memory:")

    // Create table with edge case column names
    db.run(`
      CREATE TABLE edge_cases (
        id TEXT PRIMARY KEY,
        https_url TEXT,
        user_id TEXT,
        xml_parser TEXT
      )
    `)

    db.run(`
      INSERT INTO edge_cases (id, https_url, user_id, xml_parser) VALUES
      ('1', 'https://example.com', 'usr_123', 'libxml2')
    `)

    // Property names with consecutive capitals
    const propertyNames = ["ID", "HTTPSUrl", "userID", "XMLParser"]
    const columnPropertyMap = createColumnPropertyMap(propertyNames)
    const propertyTypes = {
      ID: "string",
      HTTPSUrl: "string",
      userID: "string",
      XMLParser: "string"
    }

    executor = new SqlQueryExecutor(
      "edge_cases",
      new SqlBackend("sqlite"),
      new BunSqlExecutor(db),
      columnPropertyMap,
      "sqlite",
      propertyTypes
    )
  })

  afterEach(() => {
    db.close()
  })

  test("HTTPSUrl → https_url (input normalization)", async () => {
    const result = await executor.select(
      parseQuery({ HTTPSUrl: "https://example.com" })
    )

    expect(result).toHaveLength(1)
  })

  test("https_url → HTTPSUrl (output normalization)", async () => {
    const result = await executor.select(parseQuery({}))

    expect(result[0]).toHaveProperty("HTTPSUrl", "https://example.com")
    expect(result[0]).not.toHaveProperty("httpsUrl")
    expect(result[0]).not.toHaveProperty("https_url")
  })

  test("XMLParser round-trip", async () => {
    const result = await executor.select(
      parseQuery({ XMLParser: "libxml2" })
    )

    expect(result).toHaveLength(1)
    expect(result[0].XMLParser).toBe("libxml2")
  })

  test("userID vs userId distinction", async () => {
    const result = await executor.select(parseQuery({}))

    // Should preserve original casing from schema
    expect(result[0]).toHaveProperty("userID", "usr_123")
    expect(result[0]).not.toHaveProperty("userId")
  })
})

// ============================================================================
// SQL-03: Contract Compliance
// ============================================================================

testExecutorContract<{ id: string; name: string }>(
  "SqlQueryExecutor",
  async () => {
    const db = new Database(":memory:")

    db.run(`
      CREATE TABLE contract_test (
        id TEXT PRIMARY KEY,
        name TEXT
      )
    `)

    const testData = [
      { id: "test-1", name: "Test One" },
      { id: "test-2", name: "Test Two" },
      { id: "test-3", name: "Test Three" }
    ]

    for (const item of testData) {
      db.run("INSERT INTO contract_test (id, name) VALUES (?, ?)", [
        item.id,
        item.name
      ])
    }

    const propertyNames = ["id", "name"]
    const columnPropertyMap = createColumnPropertyMap(propertyNames)
    const propertyTypes = {
      id: "string",
      name: "string"
    }

    const executor = new SqlQueryExecutor<{ id: string; name: string }>(
      "contract_test",
      new SqlBackend("sqlite"),
      new BunSqlExecutor(db),
      columnPropertyMap,
      "sqlite",
      propertyTypes
    )

    return {
      executor,
      testData,
      cleanup: async () => {
        db.close()
      }
    }
  }
)

// ============================================================================
// SQL-04: SqlQueryExecutor Mutation Tests (Layer 4a RED Tests)
// ============================================================================

describe("SQL-04: SqlQueryExecutor Mutation Operations", () => {
  type TestEntity = {
    id: string
    name: string
    status: string
    age: number
  }

  let db: Database
  let executor: SqlQueryExecutor<TestEntity>

  beforeEach(() => {
    db = new Database(":memory:")

    db.run(`
      CREATE TABLE test_entity (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        age INTEGER NOT NULL
      )
    `)

    // Seed with initial data
    db.run(`
      INSERT INTO test_entity (id, name, status, age) VALUES
      ('1', 'Alice', 'active', 30),
      ('2', 'Bob', 'inactive', 25)
    `)

    const propertyNames = ["id", "name", "status", "age"]
    const columnPropertyMap = createColumnPropertyMap(propertyNames)
    const propertyTypes = {
      id: "string",
      name: "string",
      status: "string",
      age: "number"
    }

    executor = new SqlQueryExecutor(
      "test_entity",
      new SqlBackend("sqlite"),
      new BunSqlExecutor(db),
      columnPropertyMap,
      "sqlite",
      propertyTypes
    )
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // insert() Tests
  // ==========================================================================

  test("insert() generates INSERT SQL with snake_case columns", async () => {
    const entity = await executor.insert({
      name: "Charlie",
      status: "active",
      age: 35
    })

    expect(entity).toBeDefined()
    expect(entity.id).toBeDefined()
    expect(entity.name).toBe("Charlie")
    expect(entity.status).toBe("active")
    expect(entity.age).toBe(35)
  })

  test("insert() generates id if not provided", async () => {
    const entity = await executor.insert({
      name: "David",
      status: "pending",
      age: 40
    })

    expect(entity.id).toBeDefined()
    expect(typeof entity.id).toBe("string")
    expect(entity.id.length).toBeGreaterThan(0)
  })

  test("insert() preserves explicit id", async () => {
    const entity = await executor.insert({
      id: "custom-id-123",
      name: "Eve",
      status: "active",
      age: 28
    })

    expect(entity.id).toBe("custom-id-123")
  })

  test("insert() uses correct placeholder style for SQLite", async () => {
    // SQLite uses ? placeholders
    const entity = await executor.insert({
      name: "Test",
      status: "active",
      age: 99
    })

    // If placeholders are wrong, this would throw
    expect(entity).toBeDefined()
  })

  test("inserted entity is retrievable via select", async () => {
    const inserted = await executor.insert({
      name: "Frank",
      status: "active",
      age: 45
    })

    const found = await executor.first(parseQuery({ id: inserted.id }))
    expect(found).toBeDefined()
    expect(found?.name).toBe("Frank")
  })

  test("insert() returns normalized camelCase properties", async () => {
    const entity = await executor.insert({
      name: "Grace",
      status: "active",
      age: 33
    })

    // Should have camelCase properties (not snake_case)
    expect(entity).toHaveProperty("name")
    expect(entity).toHaveProperty("status")
    expect(entity).toHaveProperty("age")
    expect(entity).not.toHaveProperty("user_name")
  })

  // ==========================================================================
  // update() Tests
  // ==========================================================================

  test("update() generates UPDATE SQL with WHERE id", async () => {
    const updated = await executor.update("1", { name: "Alice Updated" })

    expect(updated).toBeDefined()
    expect(updated?.id).toBe("1")
    expect(updated?.name).toBe("Alice Updated")
    expect(updated?.status).toBe("active") // unchanged
    expect(updated?.age).toBe(30) // unchanged
  })

  test("update() merges partial changes", async () => {
    const updated = await executor.update("1", { status: "inactive" })

    expect(updated?.name).toBe("Alice") // unchanged
    expect(updated?.status).toBe("inactive") // updated
    expect(updated?.age).toBe(30) // unchanged
  })

  test("update() returns undefined for non-existent id", async () => {
    const result = await executor.update("nonexistent", { name: "Ghost" })

    expect(result).toBeUndefined()
  })

  test("update() persists changes in database", async () => {
    await executor.update("1", { name: "Persisted", age: 31 })

    // Query directly to verify persistence
    const found = await executor.first(parseQuery({ id: "1" }))
    expect(found?.name).toBe("Persisted")
    expect(found?.age).toBe(31)
  })

  test("update() converts camelCase to snake_case in SET clause", async () => {
    // This would fail if snake_case conversion isn't working
    const updated = await executor.update("1", { status: "archived" })

    expect(updated?.status).toBe("archived")
  })

  // ==========================================================================
  // delete() Tests
  // ==========================================================================

  test("delete() returns true when entity deleted", async () => {
    const result = await executor.delete("1")

    expect(result).toBe(true)
  })

  test("delete() returns false for non-existent id", async () => {
    const result = await executor.delete("nonexistent")

    expect(result).toBe(false)
  })

  test("deleted entity is not retrievable", async () => {
    await executor.delete("1")

    const found = await executor.first(parseQuery({ id: "1" }))
    expect(found).toBeUndefined()
  })

  test("delete() generates DELETE SQL with WHERE id", async () => {
    const countBefore = await executor.count(parseQuery({}))
    expect(countBefore).toBe(2)

    await executor.delete("1")

    const countAfter = await executor.count(parseQuery({}))
    expect(countAfter).toBe(1)
  })

  // ==========================================================================
  // insertMany() Tests
  // ==========================================================================

  test("insertMany() returns array of created entities", async () => {
    const entities = await executor.insertMany([
      { name: "Batch1", status: "active", age: 20 },
      { name: "Batch2", status: "pending", age: 21 }
    ])

    expect(Array.isArray(entities)).toBe(true)
    expect(entities.length).toBe(2)
    expect(entities[0].name).toBe("Batch1")
    expect(entities[1].name).toBe("Batch2")
  })

  test("insertMany() assigns unique ids", async () => {
    const entities = await executor.insertMany([
      { name: "A", status: "active", age: 1 },
      { name: "B", status: "active", age: 2 }
    ])

    expect(entities[0].id).toBeDefined()
    expect(entities[1].id).toBeDefined()
    expect(entities[0].id).not.toBe(entities[1].id)
  })

  test("insertMany() uses transaction for atomicity", async () => {
    // Count before
    const countBefore = await executor.count(parseQuery({}))

    // Insert multiple
    await executor.insertMany([
      { name: "Tx1", status: "active", age: 10 },
      { name: "Tx2", status: "active", age: 11 },
      { name: "Tx3", status: "active", age: 12 }
    ])

    // Count after - all should be inserted
    const countAfter = await executor.count(parseQuery({}))
    expect(countAfter).toBe(countBefore + 3)
  })

  // ==========================================================================
  // updateMany() Tests
  // ==========================================================================

  test("updateMany() returns count of updated entities", async () => {
    const count = await executor.updateMany(
      parseQuery({ status: "active" }),
      { status: "archived" }
    )

    expect(typeof count).toBe("number")
    expect(count).toBe(1) // Only Alice is active
  })

  test("updateMany() updates all matching entities", async () => {
    // First make both entities active
    await executor.update("2", { status: "active" })

    // Now update all active to archived
    await executor.updateMany(
      parseQuery({ status: "active" }),
      { status: "archived" }
    )

    // Query to verify both are archived
    const results = await executor.select(parseQuery({ status: "archived" }))
    expect(results.length).toBe(2)
  })

  test("updateMany() returns 0 when no matches", async () => {
    const count = await executor.updateMany(
      parseQuery({ status: "nonexistent" }),
      { status: "updated" }
    )

    expect(count).toBe(0)
  })

  test("updateMany() compiles filter AST to WHERE clause", async () => {
    // Insert more test data
    await executor.insertMany([
      { name: "Young1", status: "active", age: 20 },
      { name: "Young2", status: "active", age: 22 }
    ])

    // Update entities with age < 25
    const count = await executor.updateMany(
      parseQuery({ age: { $lt: 25 } }),
      { status: "young" }
    )

    expect(count).toBe(2) // Young1 and Young2
  })

  // ==========================================================================
  // deleteMany() Tests
  // ==========================================================================

  test("deleteMany() returns count of deleted entities", async () => {
    const count = await executor.deleteMany(parseQuery({ status: "active" }))

    expect(typeof count).toBe("number")
    expect(count).toBe(1) // Only Alice is active
  })

  test("deleteMany() removes all matching entities", async () => {
    // Add more entities
    await executor.insertMany([
      { name: "ToDelete1", status: "temp", age: 1 },
      { name: "ToDelete2", status: "temp", age: 2 }
    ])

    // Delete all temp status
    await executor.deleteMany(parseQuery({ status: "temp" }))

    // Verify they're gone
    const remaining = await executor.select(parseQuery({ status: "temp" }))
    expect(remaining.length).toBe(0)
  })

  test("deleteMany() returns 0 when no matches", async () => {
    const count = await executor.deleteMany(parseQuery({ status: "nonexistent" }))

    expect(count).toBe(0)
  })

  test("deleteMany() compiles filter AST to WHERE clause", async () => {
    const countBefore = await executor.count(parseQuery({}))

    // Delete all (empty filter)
    await executor.deleteMany(parseQuery({}))

    const countAfter = await executor.count(parseQuery({}))
    expect(countAfter).toBe(0)
  })
})
