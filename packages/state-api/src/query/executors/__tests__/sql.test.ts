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

    executor = new SqlQueryExecutor(
      "test_model",
      new SqlBackend(),
      new BunSqlExecutor(db),
      columnPropertyMap
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

    executor = new SqlQueryExecutor(
      "edge_cases",
      new SqlBackend(),
      new BunSqlExecutor(db),
      columnPropertyMap
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

    const executor = new SqlQueryExecutor(
      "contract_test",
      new SqlBackend(),
      new BunSqlExecutor(db),
      columnPropertyMap
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
