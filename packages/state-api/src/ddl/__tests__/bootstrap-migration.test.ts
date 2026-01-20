/**
 * Bootstrap Migration Tests
 *
 * Tests the bootstrap migration that upgrades the migration_record table
 * from v1 schema (version column) to v2 schema (fromVersion, toVersion, verified).
 *
 * Requirements:
 * - task-bootstrap-migration: Bootstrap migration for schema upgrade
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import type { ISqlExecutor } from "../../query/execution/types"
import {
  isMigrationNeeded,
  runBootstrapMigration,
} from "../bootstrap-migration"

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
  private responses: Map<string, any[]> = new Map()
  private defaultResponse: any[] = []

  setDefaultResponse(response: any[]) {
    this.defaultResponse = response
  }

  setResponseForQuery(queryPattern: string, response: any[]) {
    this.responses.set(queryPattern, response)
  }

  async execute([query, params]: [string, any[]]): Promise<any[]> {
    this.lastQuery = query
    this.lastParams = params
    this.queries.push({ query, params })

    // Check for specific query pattern responses
    for (const [pattern, response] of this.responses.entries()) {
      if (query.toLowerCase().includes(pattern.toLowerCase())) {
        return response
      }
    }

    return this.defaultResponse
  }

  async beginTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    // Mock implementation - just execute the callback with self as tx
    return callback(this)
  }

  reset() {
    this.lastQuery = ""
    this.lastParams = []
    this.queries = []
    this.responses.clear()
    this.defaultResponse = []
  }

  /** Helper to check if any query contains the given text */
  hasQueryContaining(text: string): boolean {
    return this.queries.some(q => q.query.includes(text))
  }

  /** Helper to get params for queries containing the given text */
  getParamsForQueryContaining(text: string): any[] | undefined {
    const found = this.queries.find(q => q.query.includes(text))
    return found?.params
  }
}

describe("Bootstrap Migration", () => {
  let db: Database
  let executor: BunSqlExecutor

  beforeEach(() => {
    // Create fresh in-memory SQLite database
    db = new Database(":memory:")
    executor = new BunSqlExecutor(db)
  })

  describe("isMigrationNeeded", () => {
    test("returns needed=false when table does not exist", async () => {
      // Given: No migration_record table

      // When: Check if migration needed
      const result = await isMigrationNeeded(executor, "sqlite")

      // Then: Not needed (fresh install)
      expect(result.needed).toBe(false)
      expect(result.reason).toContain("does not exist")
    })

    test("returns needed=true when v1 schema exists (version column)", async () => {
      // Given: v1 schema with version column
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "statements" TEXT,
          "success" INTEGER NOT NULL,
          "error_message" TEXT
        )
      `)

      // When: Check if migration needed
      const result = await isMigrationNeeded(executor, "sqlite")

      // Then: Migration needed
      expect(result.needed).toBe(true)
      expect(result.reason).toContain("v1 schema")
      expect(result.currentColumns).toContain("version")
    })

    test("returns needed=false when v2 schema exists", async () => {
      // Given: v2 schema with from_version, to_version, verified columns
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "from_version" INTEGER,
          "to_version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "statements" TEXT,
          "success" INTEGER NOT NULL,
          "verified" INTEGER NOT NULL,
          "error_message" TEXT,
          "verification_details" TEXT
        )
      `)

      // When: Check if migration needed
      const result = await isMigrationNeeded(executor, "sqlite")

      // Then: Not needed (already v2)
      expect(result.needed).toBe(false)
      expect(result.reason).toContain("v2 schema")
    })
  })

  describe("runBootstrapMigration", () => {
    test("returns no_table action when table does not exist", async () => {
      // Given: No migration_record table

      // When: Run migration
      const result = await runBootstrapMigration(executor, "sqlite")

      // Then: No-op
      expect(result.success).toBe(true)
      expect(result.action).toBe("no_table")
    })

    test("returns already_migrated when v2 schema exists", async () => {
      // Given: v2 schema already in place
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "from_version" INTEGER,
          "to_version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "statements" TEXT,
          "success" INTEGER NOT NULL,
          "verified" INTEGER NOT NULL,
          "error_message" TEXT,
          "verification_details" TEXT
        )
      `)

      // When: Run migration
      const result = await runBootstrapMigration(executor, "sqlite")

      // Then: No-op
      expect(result.success).toBe(true)
      expect(result.action).toBe("already_migrated")
    })

    test("migrates v1 schema to v2 schema preserving data", async () => {
      // Given: v1 schema with existing data
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "statements" TEXT,
          "success" INTEGER NOT NULL,
          "error_message" TEXT
        )
      `)

      // Insert test data
      db.run(`
        INSERT INTO "system_migrations__migration_record"
        ("id", "schema_name", "version", "checksum", "applied_at", "success")
        VALUES ('test-1', 'user-schema', 1, 'abc123', 1000, 1)
      `)
      db.run(`
        INSERT INTO "system_migrations__migration_record"
        ("id", "schema_name", "version", "checksum", "applied_at", "success")
        VALUES ('test-2', 'user-schema', 2, 'def456', 2000, 1)
      `)

      // When: Run migration
      const result = await runBootstrapMigration(executor, "sqlite")

      // Then: Migration successful
      expect(result.success).toBe(true)
      expect(result.action).toBe("migrated")
      expect(result.statementsExecuted).toBeDefined()
      expect(result.statementsExecuted!.length).toBeGreaterThan(0)

      // Verify data was preserved
      const rows = await executor.execute([
        `SELECT * FROM "system_migrations__migration_record" ORDER BY "to_version"`,
        []
      ])

      expect(rows.length).toBe(2)

      // First record
      const row1 = rows[0] as any
      expect(row1.id).toBe("test-1")
      expect(row1.schema_name).toBe("user-schema")
      expect(row1.to_version).toBe(1)
      expect(row1.from_version).toBeNull()
      expect(row1.verified).toBe(1) // SQLite stores boolean as 1/0

      // Second record
      const row2 = rows[1] as any
      expect(row2.id).toBe("test-2")
      expect(row2.to_version).toBe(2)
    })

    test("idempotent - safe to run multiple times", async () => {
      // Given: v1 schema
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "statements" TEXT,
          "success" INTEGER NOT NULL,
          "error_message" TEXT
        )
      `)

      db.run(`
        INSERT INTO "system_migrations__migration_record"
        ("id", "schema_name", "version", "checksum", "applied_at", "success")
        VALUES ('test-1', 'test-schema', 1, 'abc123', 1000, 1)
      `)

      // When: Run migration twice
      const result1 = await runBootstrapMigration(executor, "sqlite")
      const result2 = await runBootstrapMigration(executor, "sqlite")

      // Then: First migrates, second is already_migrated
      expect(result1.success).toBe(true)
      expect(result1.action).toBe("migrated")

      expect(result2.success).toBe(true)
      expect(result2.action).toBe("already_migrated")

      // Data still intact
      const rows = await executor.execute([
        `SELECT * FROM "system_migrations__migration_record"`,
        []
      ])
      expect(rows.length).toBe(1)
    })

    test("verifies migration success using introspection", async () => {
      // Given: v1 schema
      db.run(`
        CREATE TABLE "system_migrations__migration_record" (
          "id" TEXT PRIMARY KEY,
          "schema_name" TEXT NOT NULL,
          "version" INTEGER NOT NULL,
          "checksum" TEXT NOT NULL,
          "applied_at" INTEGER NOT NULL,
          "success" INTEGER NOT NULL
        )
      `)

      // When: Run migration
      const result = await runBootstrapMigration(executor, "sqlite")

      // Then: Success and verify new columns exist
      expect(result.success).toBe(true)

      // Check columns directly
      const columnInfo = db.query(`PRAGMA table_info("system_migrations__migration_record")`).all()
      const columnNames = (columnInfo as any[]).map(c => c.name.toLowerCase())

      expect(columnNames).toContain("from_version")
      expect(columnNames).toContain("to_version")
      expect(columnNames).toContain("verified")
      expect(columnNames).toContain("verification_details")
      expect(columnNames).not.toContain("version") // Old column should be gone
    })
  })

  describe("exports", () => {
    test("functions are exported from barrel", async () => {
      const ddl = await import("../index")

      expect(typeof ddl.isMigrationNeeded).toBe("function")
      expect(typeof ddl.runBootstrapMigration).toBe("function")
    })
  })
})

// ============================================================================
// PostgreSQL Dialect Tests
// ============================================================================

describe("Bootstrap Migration - PostgreSQL Dialect", () => {
  let mockPgExecutor: MockPgExecutor

  beforeEach(() => {
    mockPgExecutor = new MockPgExecutor()
  })

  describe("isMigrationNeeded() - PostgreSQL", () => {
    test("queries correct schema name (without __ suffix) for PostgreSQL", async () => {
      // Given: Mock response for table exists check
      mockPgExecutor.setResponseForQuery("information_schema.tables", [{ "1": 1 }])
      // Mock response for columns - v1 schema with "version" column
      mockPgExecutor.setResponseForQuery("information_schema.columns", [
        { column_name: "id", data_type: "text", is_nullable: "NO" },
        { column_name: "schema_name", data_type: "text", is_nullable: "NO" },
        { column_name: "version", data_type: "integer", is_nullable: "NO" },
        { column_name: "checksum", data_type: "text", is_nullable: "NO" },
        { column_name: "applied_at", data_type: "bigint", is_nullable: "NO" },
        { column_name: "success", data_type: "boolean", is_nullable: "NO" },
      ])

      // When: Check if migration needed
      const result = await isMigrationNeeded(mockPgExecutor, "pg")

      // Then: Should query "system_migrations" schema (NOT "system_migrations__")
      const tableCheckParams = mockPgExecutor.getParamsForQueryContaining("information_schema.tables")
      expect(tableCheckParams).toBeDefined()
      expect(tableCheckParams![0]).toBe("system_migrations") // NOT "system_migrations__"
      expect(tableCheckParams![0]).not.toContain("__")

      // Should find v1 schema and report migration needed
      expect(result.needed).toBe(true)
    })

    test("returns needed=false when table does not exist in PostgreSQL schema", async () => {
      // Given: No table exists
      mockPgExecutor.setResponseForQuery("information_schema.tables", [])

      // When: Check if migration needed
      const result = await isMigrationNeeded(mockPgExecutor, "pg")

      // Then: Not needed (fresh install)
      expect(result.needed).toBe(false)
      expect(result.reason).toContain("does not exist")
    })

    test("returns needed=false when v2 schema exists in PostgreSQL", async () => {
      // Given: Table exists with v2 schema
      mockPgExecutor.setResponseForQuery("information_schema.tables", [{ "1": 1 }])
      mockPgExecutor.setResponseForQuery("information_schema.columns", [
        { column_name: "id", data_type: "text", is_nullable: "NO" },
        { column_name: "schema_name", data_type: "text", is_nullable: "NO" },
        { column_name: "from_version", data_type: "integer", is_nullable: "YES" },
        { column_name: "to_version", data_type: "integer", is_nullable: "NO" },
        { column_name: "verified", data_type: "boolean", is_nullable: "NO" },
        { column_name: "verification_details", data_type: "text", is_nullable: "YES" },
      ])

      // When: Check if migration needed
      const result = await isMigrationNeeded(mockPgExecutor, "pg")

      // Then: Not needed (already v2)
      expect(result.needed).toBe(false)
      expect(result.reason).toContain("v2 schema")
    })
  })

  describe("runBootstrapMigration() - PostgreSQL", () => {
    test("uses correct schema name in ALTER TABLE statements", async () => {
      // Given: v1 schema exists
      mockPgExecutor.setResponseForQuery("information_schema.tables", [{ "1": 1 }])
      // First call returns v1 schema (for migration check)
      mockPgExecutor.setResponseForQuery("information_schema.columns", [
        { column_name: "id", data_type: "text", is_nullable: "NO" },
        { column_name: "version", data_type: "integer", is_nullable: "NO" },
        { column_name: "checksum", data_type: "text", is_nullable: "NO" },
        { column_name: "applied_at", data_type: "bigint", is_nullable: "NO" },
        { column_name: "success", data_type: "boolean", is_nullable: "NO" },
      ])

      // When: Run migration
      const result = await runBootstrapMigration(mockPgExecutor, "pg")

      // Then: ALTER TABLE statements should use schema-qualified table name
      // The table should be referenced as "system_migrations"."migration_record"
      // NOT "system_migrations__migration_record"
      const alterQueries = mockPgExecutor.queries.filter(q =>
        q.query.includes("ALTER TABLE")
      )

      // Should have ALTER TABLE statements for adding new columns
      expect(alterQueries.length).toBeGreaterThan(0)

      // None should use the __ pattern for PostgreSQL
      for (const q of alterQueries) {
        expect(q.query).not.toContain("system_migrations__migration_record")
        // Should use proper PostgreSQL schema.table format or just table name
        // (since we're in the correct schema context)
      }
    })
  })
})

// ============================================================================
// Namespace Semantics Tests
// ============================================================================

describe("Bootstrap Migration - Namespace Semantics", () => {
  test("namespace constant should be 'system_migrations' without __ suffix", async () => {
    // This is a design contract test
    // The bootstrap migration should use the same namespace semantics as introspection
    // Namespace = "system_migrations" NOT "system_migrations__"

    // We verify this by checking that PostgreSQL introspection queries
    // receive the namespace without the __ suffix
    const mockPgExecutor = new MockPgExecutor()
    mockPgExecutor.setResponseForQuery("information_schema.tables", [])

    await isMigrationNeeded(mockPgExecutor, "pg")

    // The first param to table exists query should be the schema name
    const params = mockPgExecutor.getParamsForQueryContaining("information_schema.tables")
    expect(params).toBeDefined()
    expect(params![0]).toBe("system_migrations")
    expect(params![0]).not.toMatch(/__$/) // Should not end with __
  })
})
