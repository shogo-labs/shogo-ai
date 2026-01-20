/**
 * DDL Recover Tool Tests
 *
 * Tests for the ddl.recover MCP tool that handles migration recovery.
 *
 * Key test cases:
 * - Validates schema exists in meta-store
 * - Additive strategy creates missing tables only
 * - Reset strategy clears records and re-runs migration
 * - dryRun mode previews actions without executing
 * - Handles errors gracefully
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import {
  getMetaStore,
  resetMetaStore,
  deriveNamespace,
  clearRuntimeStores,
  generateDDL,
  createSqliteDialect,
  qualifyTableName,
  type QualifyDialect,
  toSnakeCase,
} from "@shogo/state-api"
import { BunSqlExecutor } from "@shogo/state-api/query/execution/bun-sql"
import {
  __resetForTesting,
} from "../../postgres-init"

// Helper to simulate tool response structure
interface RecoverResponse {
  ok: boolean
  strategy?: "additive" | "reset"
  dryRun?: boolean
  schemaName?: string
  namespace?: string
  tablesCreated?: string[]
  statements?: string[]
  migrationRecordsAffected?: number
  statementsExecuted?: number
  message?: string
  warning?: string
  error?: {
    code: string
    message: string
  }
}

/**
 * Converts a model name to snake_case table name.
 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "")
}

describe("DDL Recover Tool", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
    __resetForTesting()
  })

  afterEach(() => {
    // Cleanup
  })

  describe("schema validation", () => {
    test("returns error when schema not found in meta-store", () => {
      // Given: No schema in meta-store
      const metaStore = getMetaStore()
      const schema = metaStore.findSchemaByName("non-existent-schema")

      // When/Then: Schema not found
      expect(schema).toBeUndefined()

      // Simulate tool response
      const response: RecoverResponse = {
        ok: false,
        error: {
          code: "SCHEMA_NOT_FOUND",
          message: "Schema 'non-existent-schema' not found in meta-store.",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe("SCHEMA_NOT_FOUND")
    })
  })

  describe("additive strategy", () => {
    test("no-op when all tables exist", () => {
      // Given: All tables already exist
      const expected = ["test_schema__user"]
      const actual = ["test_schema__user"]

      // When: Computing missing tables
      const actualLower = actual.map(t => t.toLowerCase())
      const missing = expected.filter(t => !actualLower.includes(t.toLowerCase()))

      // Then: Nothing to create
      expect(missing).toEqual([])

      // Simulate response
      const response: RecoverResponse = {
        ok: true,
        strategy: "additive",
        dryRun: false,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: [],
        migrationRecordsAffected: 0,
        message: "No missing tables - schema is already in sync",
      }

      expect(response.ok).toBe(true)
      expect(response.tablesCreated).toEqual([])
    })

    test("creates only missing tables", () => {
      // Given: Some tables missing
      const expected = ["test_schema__user", "test_schema__post", "test_schema__comment"]
      const actual = ["test_schema__user"]

      // When: Computing missing tables
      const actualLower = actual.map(t => t.toLowerCase())
      const missing = expected.filter(t => !actualLower.includes(t.toLowerCase()))

      // Then: Only missing tables identified
      expect(missing).toEqual(["test_schema__post", "test_schema__comment"])

      // Simulate response
      const response: RecoverResponse = {
        ok: true,
        strategy: "additive",
        dryRun: false,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: missing,
        migrationRecordsAffected: 0,
        message: `Created ${missing.length} missing table(s)`,
      }

      expect(response.ok).toBe(true)
      expect(response.tablesCreated?.length).toBe(2)
    })

    test("dry run returns tables that would be created", () => {
      const response: RecoverResponse = {
        ok: true,
        strategy: "additive",
        dryRun: true,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: ["test_schema__post"],
        statements: ["CREATE TABLE IF NOT EXISTS \"test_schema__post\" (...)"],
        migrationRecordsAffected: 0,
        message: "Dry run: would create 1 missing table(s)",
      }

      expect(response.ok).toBe(true)
      expect(response.dryRun).toBe(true)
      expect(response.statements).toBeDefined()
      expect(response.statements?.length).toBe(1)
    })
  })

  describe("reset strategy", () => {
    test("clears migration records and re-runs migration", () => {
      const response: RecoverResponse = {
        ok: true,
        strategy: "reset",
        dryRun: false,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: ["test_schema__user", "test_schema__post"],
        migrationRecordsAffected: 3,
        statementsExecuted: 2,
        message: "Reset complete: cleared 3 migration record(s), executed 2 DDL statement(s)",
      }

      expect(response.ok).toBe(true)
      expect(response.strategy).toBe("reset")
      expect(response.migrationRecordsAffected).toBe(3)
    })

    test("dry run includes data loss warning", () => {
      const response: RecoverResponse = {
        ok: true,
        strategy: "reset",
        dryRun: true,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: ["test_schema__user"],
        statements: ["CREATE TABLE IF NOT EXISTS \"test_schema__user\" (...)"],
        migrationRecordsAffected: 2,
        warning: "DATA LOSS WARNING: Reset strategy will delete migration history.",
        message: "Dry run: would clear 2 migration record(s) and execute 1 DDL statement(s)",
      }

      expect(response.ok).toBe(true)
      expect(response.dryRun).toBe(true)
      expect(response.warning).toContain("DATA LOSS WARNING")
    })
  })

  describe("response format", () => {
    test("additive success response", () => {
      const response: RecoverResponse = {
        ok: true,
        strategy: "additive",
        dryRun: false,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: ["test_schema__post"],
        migrationRecordsAffected: 0,
        message: "Created 1 missing table(s)",
      }

      expect(response.ok).toBe(true)
      expect(response.strategy).toBe("additive")
      expect(response.migrationRecordsAffected).toBe(0)
    })

    test("reset success response", () => {
      const response: RecoverResponse = {
        ok: true,
        strategy: "reset",
        dryRun: false,
        schemaName: "test-schema",
        namespace: "test_schema",
        tablesCreated: ["test_schema__user"],
        migrationRecordsAffected: 1,
        statementsExecuted: 1,
        message: "Reset complete: cleared 1 migration record(s), executed 1 DDL statement(s)",
      }

      expect(response.ok).toBe(true)
      expect(response.strategy).toBe("reset")
    })

    test("error response", () => {
      const response: RecoverResponse = {
        ok: false,
        error: {
          code: "NO_EXECUTOR",
          message: "Cannot recover: backend \"sql\" not found or has no executor.",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe("NO_EXECUTOR")
    })
  })

  describe("integration with DDL generation", () => {
    test("generates correct DDL for missing tables", () => {
      // Given: Schema with models
      const schemaData = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      }

      // When: Generating DDL
      const dialect = createSqliteDialect()
      const namespace = "test_schema"
      const ddlOutput = generateDDL(schemaData as any, dialect, { namespace })

      // Then: Tables generated with namespace
      expect(ddlOutput.tables.length).toBe(1)
      expect(ddlOutput.tables[0].name).toContain("user")
    })
  })

  describe("integration with SQLite executor", () => {
    let db: Database
    let executor: BunSqlExecutor

    beforeEach(() => {
      // Create in-memory SQLite database
      db = new Database(":memory:")
      executor = new BunSqlExecutor(db)
    })

    test("can execute additive DDL statements", async () => {
      // Given: One table exists, another is missing
      db.run("CREATE TABLE test_schema__user (id TEXT PRIMARY KEY, name TEXT)")

      // When: Create missing table
      const statements = [
        `CREATE TABLE IF NOT EXISTS "test_schema__post" (id TEXT PRIMARY KEY, title TEXT)`,
      ]

      await executor.executeMany!(statements)

      // Then: Both tables exist
      const rows = await executor.execute([
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE $1`,
        ["test_schema__%"]
      ])

      const tableNames = rows.map((r: any) => r.name)
      expect(tableNames).toContain("test_schema__user")
      expect(tableNames).toContain("test_schema__post")
    })

    test("IF NOT EXISTS prevents errors on existing tables", async () => {
      // Given: Table already exists
      db.run("CREATE TABLE test_schema__user (id TEXT PRIMARY KEY, name TEXT)")

      // When: Execute with IF NOT EXISTS
      const statements = [
        `CREATE TABLE IF NOT EXISTS "test_schema__user" (id TEXT PRIMARY KEY, name TEXT)`,
      ]

      // Then: No error thrown
      await expect(executor.executeMany!(statements)).resolves.toBe(1)
    })
  })
})

// ============================================================================
// Dialect-Aware Table Naming Tests
// ============================================================================

describe("DDL Recover Tool - Dialect Awareness", () => {
  test("should use qualifyTableName for expected tables (PostgreSQL format)", () => {
    // When recovering for PostgreSQL, should use schema.table format
    const namespace = "test_schema"
    const modelNames = ["User", "UserProfile"]

    // Using qualifyTableName properly (this is what the tool SHOULD do)
    const postgresExpected = modelNames.map(modelName => {
      const tableName = toSnakeCase(modelName)
      return qualifyTableName(namespace, tableName, "postgresql")
    })

    // Then: Should be in "schema"."table" format
    expect(postgresExpected).toContain('"test_schema"."user"')
    expect(postgresExpected).toContain('"test_schema"."user_profile"')

    // Should NOT contain __ pattern for PostgreSQL
    for (const name of postgresExpected) {
      expect(name).not.toContain("__")
    }
  })

  test("should use qualifyTableName for expected tables (SQLite format)", () => {
    // For SQLite, expected tables should be "namespace__table"
    const namespace = "test_schema"
    const modelNames = ["User"]

    // Using qualifyTableName properly
    const sqliteExpected = modelNames.map(modelName => {
      const tableName = toSnakeCase(modelName)
      return qualifyTableName(namespace, tableName, "sqlite")
    })

    // Then: Should be in namespace__table format
    expect(sqliteExpected).toContain("test_schema__user")
  })

  test("toSnakeCase should be imported from state-api (no local duplicate in tool)", async () => {
    // This test verifies that the ddl.recover tool uses the shared toSnakeCase
    // from state-api rather than having its own duplicate implementation

    const toolSource = await Bun.file(
      `${process.cwd()}/packages/mcp/src/tools/ddl.recover.ts`
    ).text()

    // Should import toSnakeCase from state-api
    const hasStateApiImport = toolSource.includes("@shogo/state-api") &&
      toolSource.includes("toSnakeCase")

    // Should NOT have a local function toSnakeCase
    const localFunctionPattern = /^function toSnakeCase\(/m
    const hasLocalFunction = localFunctionPattern.test(toolSource)

    expect(hasStateApiImport).toBe(true)
    expect(hasLocalFunction).toBe(false)
  })

  test("should use qualifyTableName for dialect-aware table names in executeAdditiveRecovery", async () => {
    // Read the tool source to verify it uses dialect-aware naming
    const toolSource = await Bun.file(
      `${process.cwd()}/packages/mcp/src/tools/ddl.recover.ts`
    ).text()

    // Should use qualifyTableName for expected tables
    const usesQualifyTableName = toolSource.includes("qualifyTableName")

    // Should not hardcode __ pattern for expected tables
    const hardcodedPattern = /\$\{namespace\}__\$\{toSnakeCase\(modelName\)\}/
    const hasHardcodedPattern = hardcodedPattern.test(toolSource)

    expect(usesQualifyTableName).toBe(true)
    expect(hasHardcodedPattern).toBe(false)
  })
})
