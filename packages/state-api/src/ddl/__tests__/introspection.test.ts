/**
 * Introspection Module Tests
 *
 * Tests the database introspection functions for discovering tables and columns.
 * Uses in-memory SQLite for unit tests and mock executor for PostgreSQL tests.
 *
 * Requirements:
 * - task-introspection-module: Introspection functions for table/column discovery
 * - PostgreSQL dialect must query actual schema, not 'public'
 * - Namespace parameter should NOT include __ suffix
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import {
  getActualTables,
  getActualTablesFullNames,
  getTableColumns,
  tableExists,
  detectDialect,
} from "../introspection"
import type { ISqlExecutor } from "../../query/execution/types"

// ============================================================================
// Mock PostgreSQL Executor for Testing
// ============================================================================

/**
 * Mock executor that captures SQL queries and returns configured responses.
 * Used to test PostgreSQL-specific query patterns without a real database.
 */
class MockPgExecutor implements ISqlExecutor {
  /** Last query that was executed */
  lastQuery: string = ""
  /** Last params that were passed */
  lastParams: any[] = []
  /** All queries executed (for verification) */
  queries: Array<{ query: string; params: any[] }> = []
  /** Response to return from execute() */
  private response: any[] = []

  setResponse(response: any[]) {
    this.response = response
  }

  async execute([query, params]: [string, any[]]): Promise<any[]> {
    this.lastQuery = query
    this.lastParams = params
    this.queries.push({ query, params })
    return this.response
  }

  async beginTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    // Mock implementation - just execute the callback with self as tx
    return callback(this)
  }

  reset() {
    this.lastQuery = ""
    this.lastParams = []
    this.queries = []
    this.response = []
  }
}

describe("Introspection Module", () => {
  let db: Database
  let executor: BunSqlExecutor

  beforeEach(() => {
    // Create fresh in-memory SQLite database
    db = new Database(":memory:")
    executor = new BunSqlExecutor(db)

    // Create test tables with namespace prefix
    db.run(`
      CREATE TABLE test_schema__user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        age INTEGER
      )
    `)
    db.run(`
      CREATE TABLE test_schema__post (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_id TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE other_schema__item (
        id TEXT PRIMARY KEY,
        name TEXT
      )
    `)
  })

  describe("detectDialect", () => {
    test("should detect sqlite dialect from BunSqlExecutor", async () => {
      const dialect = await detectDialect(executor)
      expect(dialect).toBe("sqlite")
    })
  })

  describe("getActualTables", () => {
    test("should return tables matching namespace prefix", async () => {
      const tables = await getActualTables("test_schema__", executor, "sqlite")

      expect(tables).toContain("user")
      expect(tables).toContain("post")
      expect(tables).not.toContain("item") // Different namespace
      expect(tables.length).toBe(2)
    })

    test("should return empty array for non-existent namespace", async () => {
      const tables = await getActualTables("nonexistent__", executor, "sqlite")
      expect(tables).toEqual([])
    })

    test("should strip namespace prefix from table names", async () => {
      const tables = await getActualTables("test_schema__", executor, "sqlite")

      // Should return logical names without prefix
      expect(tables.every(t => !t.startsWith("test_schema__"))).toBe(true)
    })
  })

  describe("getActualTablesFullNames", () => {
    test("should return full table names with namespace prefix", async () => {
      const tables = await getActualTablesFullNames("test_schema__", executor, "sqlite")

      expect(tables).toContain("test_schema__user")
      expect(tables).toContain("test_schema__post")
      expect(tables.length).toBe(2)
    })
  })

  describe("getTableColumns", () => {
    test("should return column info for existing table", async () => {
      const columns = await getTableColumns("test_schema__", "user", executor, "sqlite")

      expect(columns.length).toBe(4)

      const idCol = columns.find(c => c.name === "id")
      expect(idCol).toBeDefined()
      expect(idCol!.type).toBe("TEXT")
      expect(idCol!.nullable).toBe(false) // PRIMARY KEY implies NOT NULL

      const nameCol = columns.find(c => c.name === "name")
      expect(nameCol).toBeDefined()
      expect(nameCol!.nullable).toBe(false) // NOT NULL constraint

      const emailCol = columns.find(c => c.name === "email")
      expect(emailCol).toBeDefined()
      expect(emailCol!.nullable).toBe(true) // No NOT NULL constraint

      const ageCol = columns.find(c => c.name === "age")
      expect(ageCol).toBeDefined()
      expect(ageCol!.type).toBe("INTEGER")
    })

    test("should return empty array for non-existent table", async () => {
      const columns = await getTableColumns("test_schema__", "nonexistent", executor, "sqlite")
      expect(columns).toEqual([])
    })
  })

  describe("tableExists", () => {
    test("should return true for existing table", async () => {
      const exists = await tableExists("test_schema__", "user", executor, "sqlite")
      expect(exists).toBe(true)
    })

    test("should return false for non-existent table", async () => {
      const exists = await tableExists("test_schema__", "nonexistent", executor, "sqlite")
      expect(exists).toBe(false)
    })

    test("should return false for table in different namespace", async () => {
      const exists = await tableExists("test_schema__", "item", executor, "sqlite")
      expect(exists).toBe(false)
    })
  })
})

describe("Introspection exports", () => {
  test("functions are exported from barrel", async () => {
    const ddl = await import("../index")

    expect(typeof ddl.getActualTables).toBe("function")
    expect(typeof ddl.getActualTablesFullNames).toBe("function")
    expect(typeof ddl.getTableColumns).toBe("function")
    expect(typeof ddl.tableExists).toBe("function")
    expect(typeof ddl.detectDialect).toBe("function")
  })
})

// ============================================================================
// PostgreSQL Dialect Tests
// ============================================================================

describe("Introspection Module - PostgreSQL Dialect", () => {
  let mockPgExecutor: MockPgExecutor

  beforeEach(() => {
    mockPgExecutor = new MockPgExecutor()
  })

  describe("tableExists()", () => {
    test("queries namespace schema (not 'public') for PostgreSQL", async () => {
      // Given: Table exists in 'system_migrations' schema
      mockPgExecutor.setResponse([{ "1": 1 }])

      // When: Check table exists (namespace WITHOUT __ suffix)
      const exists = await tableExists("system_migrations", "migration_record", mockPgExecutor, "pg")

      // Then: Query should use table_schema = $1 with namespace as parameter
      expect(mockPgExecutor.lastQuery).toContain("table_schema = $1")
      expect(mockPgExecutor.lastParams).toContain("system_migrations")
      // Should NOT hardcode 'public'
      expect(mockPgExecutor.lastQuery).not.toContain("'public'")
      expect(exists).toBe(true)
    })

    test("returns false when table does not exist in PostgreSQL schema", async () => {
      // Given: No matching table
      mockPgExecutor.setResponse([])

      // When: Check table exists
      const exists = await tableExists("system_migrations", "nonexistent", mockPgExecutor, "pg")

      // Then: Should return false
      expect(exists).toBe(false)
    })

    test("passes namespace and tableName as separate parameters for PostgreSQL", async () => {
      // Given: Mock response
      mockPgExecutor.setResponse([{ "1": 1 }])

      // When: Check table exists
      await tableExists("system_migrations", "migration_record", mockPgExecutor, "pg")

      // Then: Should pass namespace as $1 and tableName as $2
      expect(mockPgExecutor.lastParams[0]).toBe("system_migrations")
      expect(mockPgExecutor.lastParams[1]).toBe("migration_record")
    })
  })

  describe("getTableColumns()", () => {
    test("queries columns from namespace schema for PostgreSQL", async () => {
      // Given: Columns exist
      mockPgExecutor.setResponse([
        { column_name: "id", data_type: "text", is_nullable: "NO" },
        { column_name: "name", data_type: "text", is_nullable: "YES" },
      ])

      // When: Get columns (namespace WITHOUT __ suffix)
      const columns = await getTableColumns("system_migrations", "migration_record", mockPgExecutor, "pg")

      // Then: Query should use table_schema = $1
      expect(mockPgExecutor.lastQuery).toContain("table_schema = $1")
      expect(mockPgExecutor.lastParams[0]).toBe("system_migrations")
      expect(mockPgExecutor.lastParams[1]).toBe("migration_record")
      // Should NOT hardcode 'public'
      expect(mockPgExecutor.lastQuery).not.toContain("'public'")
      // Should return columns
      expect(columns.length).toBe(2)
      expect(columns[0].name).toBe("id")
    })

    test("returns empty array when table has no columns", async () => {
      mockPgExecutor.setResponse([])

      const columns = await getTableColumns("test_schema", "nonexistent", mockPgExecutor, "pg")

      expect(columns).toEqual([])
    })
  })

  describe("getActualTables()", () => {
    test("queries tables from namespace schema for PostgreSQL", async () => {
      // Given: Tables exist in schema
      mockPgExecutor.setResponse([
        { table_name: "migration_record" },
        { table_name: "other_table" },
      ])

      // When: Get tables (namespace WITHOUT __ suffix)
      const tables = await getActualTables("system_migrations", mockPgExecutor, "pg")

      // Then: Query should use table_schema = $1
      expect(mockPgExecutor.lastQuery).toContain("table_schema = $1")
      expect(mockPgExecutor.lastParams[0]).toBe("system_migrations")
      // Should NOT hardcode 'public'
      expect(mockPgExecutor.lastQuery).not.toContain("'public'")
      // Should return table names
      expect(tables).toContain("migration_record")
      expect(tables).toContain("other_table")
    })

    test("returns empty array when no tables in schema", async () => {
      mockPgExecutor.setResponse([])

      const tables = await getActualTables("empty_schema", mockPgExecutor, "pg")

      expect(tables).toEqual([])
    })
  })

  describe("getActualTablesFullNames()", () => {
    test("returns schema.table format for PostgreSQL", async () => {
      // Given: Tables exist
      mockPgExecutor.setResponse([
        { table_name: "migration_record" },
        { table_name: "other_table" },
      ])

      // When: Get full table names (namespace WITHOUT __ suffix)
      const tables = await getActualTablesFullNames("system_migrations", mockPgExecutor, "pg")

      // Then: Should return qualified names in schema.table format
      expect(tables).toContain("system_migrations.migration_record")
      expect(tables).toContain("system_migrations.other_table")
      // Should NOT use __ format for PostgreSQL
      expect(tables.every(t => !t.includes("__"))).toBe(true)
    })
  })
})

// ============================================================================
// Namespace Semantics Tests
// ============================================================================

describe("Introspection Module - Namespace Semantics", () => {
  let mockPgExecutor: MockPgExecutor
  let db: Database
  let sqliteExecutor: BunSqlExecutor

  beforeEach(() => {
    mockPgExecutor = new MockPgExecutor()
    db = new Database(":memory:")
    sqliteExecutor = new BunSqlExecutor(db)

    // Create test table for SQLite
    db.run(`CREATE TABLE test_schema__user (id TEXT PRIMARY KEY)`)
  })

  test("namespace parameter should NOT include __ suffix for PostgreSQL", async () => {
    // Document the correct API contract for PostgreSQL
    mockPgExecutor.setResponse([{ "1": 1 }])

    // Correct usage: namespace WITHOUT __
    await tableExists("system_migrations", "migration_record", mockPgExecutor, "pg")

    // The function should query with just the namespace
    expect(mockPgExecutor.lastParams[0]).toBe("system_migrations")
    expect(mockPgExecutor.lastParams[0]).not.toContain("__")
  })

  test("namespace parameter should NOT include __ suffix for SQLite", async () => {
    // Document the correct API contract for SQLite
    // Namespace = "test_schema" NOT "test_schema__"
    // The function should internally construct "test_schema__user"

    const exists = await tableExists("test_schema", "user", sqliteExecutor, "sqlite")

    // Should find the table even though we pass namespace without __
    expect(exists).toBe(true)
  })

  test("SQLite functions internally add __ separator", async () => {
    // When using namespace without __, SQLite functions should still work
    const tables = await getActualTables("test_schema", sqliteExecutor, "sqlite")

    // Should find tables with test_schema__ prefix
    expect(tables).toContain("user")
  })
})
