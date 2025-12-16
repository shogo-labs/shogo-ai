/**
 * BunSqlExecutor Tests
 *
 * Tests for the BunSqlExecutor class that wraps Bun.sql native driver.
 * Uses in-memory SQLite database for integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import type { SQL } from "bun:sql"
import { BunSqlExecutor } from "../bun-sql"
import type { ISqlExecutor } from "../types"

// Setup test database with sample data
function setupTestDatabase(): Database {
  const db = new Database(":memory:")

  // Create users table
  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER,
      created_at TEXT
    )
  `)

  // Insert test data
  db.run("INSERT INTO users (id, name, age, created_at) VALUES (1, 'Alice', 30, '2024-01-01')")
  db.run("INSERT INTO users (id, name, age, created_at) VALUES (2, 'Bob', 25, '2024-01-02')")
  db.run("INSERT INTO users (id, name, age, created_at) VALUES (3, 'Charlie', 35, '2024-01-03')")

  return db
}

describe("BunSqlExecutor", () => {
  let db: Database
  let connection: SQL
  let executor: BunSqlExecutor

  beforeEach(() => {
    db = setupTestDatabase()
    // Cast Database to SQL type for Bun.sql compatibility
    connection = db as unknown as SQL
    executor = new BunSqlExecutor(connection)
  })

  afterEach(() => {
    db.close()
  })

  /**
   * Test Spec: test-p2-bun-executor-01
   * Scenario: BunSqlExecutor implements ISqlExecutor interface
   */
  describe("Interface Implementation", () => {
    test("implements ISqlExecutor interface", () => {
      // Given: BunSqlExecutor class is available
      // And: Mock SQL connection from bun:sql

      // When: new BunSqlExecutor(connection) is instantiated
      const instance: ISqlExecutor = executor

      // Then: Instance has execute method
      expect(executor.execute).toBeDefined()
      expect(typeof executor.execute).toBe("function")

      // Then: Instance has executeMany method
      expect(executor.executeMany).toBeDefined()
      expect(typeof executor.executeMany).toBe("function")

      // Then: Instance has connection getter
      expect(executor.connection).toBeDefined()
      expect(executor.connection).toBe(connection)
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-02
   * Scenario: execute converts parameterized SQL to tagged template invocation
   */
  describe("Parameterized Query Execution", () => {
    test("converts parameterized SQL to tagged template invocation", async () => {
      // Given: BunSqlExecutor instance with test database connection
      // And: SQL string: 'SELECT * FROM users WHERE id = $1'
      // And: Params array: [1]

      // When: execute(['SELECT * FROM users WHERE id = $1', [1]]) is called
      const result = await executor.execute([
        "SELECT * FROM users WHERE id = $1",
        [1]
      ])

      // Then: SQL is split on $N placeholders via sql.split(/\$\d+/)
      // Then: Tagged template sql(parts, ...params) is invoked
      // Then: Query executes against database
      // Then: Result rows are returned
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(1)
      expect(result[0]).toMatchObject({
        id: 1,
        name: "Alice"
      })
    })

    test("handles multiple parameters", async () => {
      // Given: SQL with multiple placeholders
      const result = await executor.execute([
        "SELECT * FROM users WHERE id = $1 OR id = $2",
        [1, 3]
      ])

      // Then: Multiple parameters substituted correctly
      expect(result.length).toBe(2)
      expect(result[0].id).toBe(1)
      expect(result[1].id).toBe(3)
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-03
   * Scenario: execute handles empty params array
   */
  describe("Empty Parameters", () => {
    test("handles empty params array", async () => {
      // Given: BunSqlExecutor instance with test database connection
      // And: SQL string: 'SELECT * FROM users'
      // And: Empty params array: []

      // When: execute(['SELECT * FROM users', []]) is called
      const result = await executor.execute([
        "SELECT * FROM users",
        []
      ])

      // Then: Query executes without placeholders
      // Then: No parameter substitution errors
      // Then: Result rows are returned
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(3)
      expect(result.map(r => r.name)).toEqual(["Alice", "Bob", "Charlie"])
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-04
   * Scenario: execute handles multiple consecutive placeholders
   */
  describe("Consecutive Placeholders", () => {
    test("handles multiple consecutive placeholders", async () => {
      // Given: BunSqlExecutor instance with test database connection
      // And: SQL string: 'SELECT * FROM users WHERE age > $1 AND age < $2'
      // And: Params array: [24, 32]

      // When: execute(['SELECT * FROM users WHERE age > $1 AND age < $2', [24, 32]]) is called
      const result = await executor.execute([
        "SELECT * FROM users WHERE age > $1 AND age < $2",
        [24, 32]
      ])

      // Then: Both placeholders are substituted correctly
      // Then: Parts array has 3 elements (before $1, between $1 and $2, after $2)
      // Then: Query executes with correct parameter binding
      expect(result).toBeDefined()
      expect(result.length).toBe(2)
      expect(result.map(r => r.name).sort()).toEqual(["Alice", "Bob"])
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-05
   * Scenario: execute handles trailing placeholder
   */
  describe("Trailing Placeholder", () => {
    test("handles trailing placeholder", async () => {
      // Given: BunSqlExecutor instance with test database connection
      // And: SQL string: 'INSERT INTO users (name, age) VALUES ($1, $2)'
      // And: Params array: ['Dave', 40]

      // When: execute(['INSERT INTO users (name, age) VALUES ($1, $2)', ['Dave', 40]]) is called
      const result = await executor.execute([
        "INSERT INTO users (name, age) VALUES ($1, $2)",
        ["Dave", 40]
      ])

      // Then: Trailing placeholder handled correctly
      // Then: Parts array ends with empty string after $2
      // Then: Query executes successfully
      expect(result).toBeDefined()

      // Verify insertion worked
      const users = await executor.execute([
        "SELECT * FROM users WHERE name = $1",
        ["Dave"]
      ])
      expect(users.length).toBe(1)
      expect(users[0]).toMatchObject({
        name: "Dave",
        age: 40
      })
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-06
   * Scenario: executeMany runs batch DDL statements
   */
  describe("Batch DDL Execution", () => {
    test("executes multiple DDL statements in order", async () => {
      // Given: BunSqlExecutor instance with test database connection
      // And: Array of DDL statements: ['CREATE TABLE foo...', 'CREATE TABLE bar...']
      const statements = [
        "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT NOT NULL)"
      ]

      // When: executeMany(statements) is called
      const count = await executor.executeMany(statements)

      // Then: Each statement is executed in order
      // Then: All tables are created
      // Then: Returns count of executed statements
      expect(count).toBe(2)

      // Verify tables were created
      const insert1 = await executor.execute([
        "INSERT INTO projects (name) VALUES ($1)",
        ["My Project"]
      ])
      expect(insert1).toBeDefined()

      const insert2 = await executor.execute([
        "INSERT INTO tasks (project_id, title) VALUES ($1, $2)",
        [1, "Task 1"]
      ])
      expect(insert2).toBeDefined()
    })
  })

  /**
   * Test Spec: test-p2-bun-executor-07
   * Scenario: connection getter exposes underlying SQL connection
   */
  describe("Connection Getter", () => {
    test("exposes underlying SQL connection", () => {
      // Given: BunSqlExecutor instance with SQL connection

      // When: executor.connection is accessed
      const conn = executor.connection

      // Then: Returns the underlying SQL connection instance
      expect(conn).toBe(connection)

      // Then: Connection can be used for advanced operations
      expect(conn).toBeDefined()
    })
  })

  /**
   * Additional edge cases
   */
  describe("Edge Cases", () => {
    test("handles placeholders not in sequence", async () => {
      // Some SQL might use non-sequential placeholders
      const result = await executor.execute([
        "SELECT * FROM users WHERE id = $2 OR id = $1",
        [3, 1]
      ])

      expect(result.length).toBe(2)
    })

    test("handles complex WHERE clause with multiple operators", async () => {
      const result = await executor.execute([
        "SELECT * FROM users WHERE age >= $1 AND age <= $2 AND name != $3",
        [25, 35, "Eve"]
      ])

      expect(result.length).toBe(3)
    })

    test("returns empty array for no matches", async () => {
      const result = await executor.execute([
        "SELECT * FROM users WHERE id = $1",
        [999]
      ])

      expect(result).toBeDefined()
      expect(result.length).toBe(0)
    })
  })
})
