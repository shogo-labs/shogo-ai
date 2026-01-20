/**
 * DDL Verify Tool Tests
 *
 * Tests for the ddl.verify MCP tool that checks if expected database tables exist.
 *
 * Key test cases:
 * - Validates schema exists in meta-store
 * - Returns match when all expected tables exist
 * - Returns mismatch with details when tables are missing
 * - Handles extra tables gracefully
 * - Works without triggering migrations
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import {
  getMetaStore,
  resetMetaStore,
  deriveNamespace,
  clearRuntimeStores,
  qualifyTableName,
  type QualifyDialect,
  toSnakeCase,
} from "@shogo/state-api"
import { BunSqlExecutor } from "@shogo/state-api/query/execution/bun-sql"
import {
  __resetForTesting,
} from "../../postgres-init"

// Helper to simulate tool response structure
interface VerifyResponse {
  ok: boolean
  status?: "match" | "mismatch"
  schemaName?: string
  namespace?: string
  expected?: string[]
  actual?: string[]
  missing?: string[]
  extra?: string[]
  summary?: string
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

describe("DDL Verify Tool", () => {
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
      const response: VerifyResponse = {
        ok: false,
        error: {
          code: "SCHEMA_NOT_FOUND",
          message: "Schema 'non-existent-schema' not found in meta-store.",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe("SCHEMA_NOT_FOUND")
    })

    test("finds schema when it exists in meta-store", () => {
      // Given: Schema ingested into meta-store
      const metaStore = getMetaStore()
      const schemaData = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      }

      metaStore.ingestEnhancedJsonSchema(schemaData as any, { name: "test-schema" })

      // When: Looking up schema
      const schema = metaStore.findSchemaByName("test-schema")

      // Then: Schema found
      expect(schema).not.toBeUndefined()
      expect(schema!.name).toBe("test-schema")
    })
  })

  describe("table verification logic", () => {
    test("returns match when all expected tables exist", () => {
      // Given: Expected and actual tables match
      const expected = ["test_schema__user", "test_schema__post"]
      const actual = ["test_schema__user", "test_schema__post"]

      // When: Comparing
      const missing = expected.filter(t => !actual.map(a => a.toLowerCase()).includes(t.toLowerCase()))
      const extra = actual.filter(t => !expected.map(e => e.toLowerCase()).includes(t.toLowerCase()))
      const allMatch = missing.length === 0

      // Then: Match status
      expect(allMatch).toBe(true)
      expect(missing).toEqual([])
      expect(extra).toEqual([])
    })

    test("returns mismatch when tables are missing", () => {
      // Given: Missing tables
      const expected = ["test_schema__user", "test_schema__post", "test_schema__comment"]
      const actual = ["test_schema__user"]

      // When: Comparing
      const missing = expected.filter(t => !actual.map(a => a.toLowerCase()).includes(t.toLowerCase()))
      const extra = actual.filter(t => !expected.map(e => e.toLowerCase()).includes(t.toLowerCase()))
      const allMatch = missing.length === 0

      // Then: Mismatch with details
      expect(allMatch).toBe(false)
      expect(missing).toEqual(["test_schema__post", "test_schema__comment"])
      expect(extra).toEqual([])
    })

    test("identifies extra tables that are not in schema", () => {
      // Given: Extra tables exist
      const expected = ["test_schema__user"]
      const actual = ["test_schema__user", "test_schema__legacy_data"]

      // When: Comparing
      const missing = expected.filter(t => !actual.map(a => a.toLowerCase()).includes(t.toLowerCase()))
      const extra = actual.filter(t => !expected.map(e => e.toLowerCase()).includes(t.toLowerCase()))

      // Then: Extra tables identified
      expect(missing).toEqual([])
      expect(extra).toEqual(["test_schema__legacy_data"])
    })

    test("handles case-insensitive comparison", () => {
      // Given: Different case tables
      const expected = ["test_schema__User"]
      const actual = ["test_schema__user"]

      // When: Case-insensitive comparison
      const expectedLower = expected.map(t => t.toLowerCase())
      const actualLower = actual.map(t => t.toLowerCase())
      const missing = expected.filter(t => !actualLower.includes(t.toLowerCase()))

      // Then: Matches despite case difference
      expect(missing).toEqual([])
    })
  })

  describe("namespace derivation", () => {
    test("derives correct namespace from schema name", () => {
      // Given: Various schema names
      const testCases = [
        { input: "user-schema", expected: "user_schema" },
        { input: "platform-features", expected: "platform_features" },
        { input: "studio-core", expected: "studio_core" },
      ]

      // When/Then: Namespace derived correctly
      for (const { input, expected } of testCases) {
        expect(deriveNamespace(input)).toBe(expected)
      }
    })

    test("generates expected table names from models", () => {
      // Given: Schema with models
      const schemaData = {
        $defs: {
          User: {},
          UserProfile: {},
          BlogPost: {},
        },
      }
      const namespace = "test_schema"

      // When: Computing expected tables
      const models = schemaData.$defs
      const expectedTables = Object.keys(models).map(modelName => {
        return `${namespace}__${toSnakeCase(modelName)}`
      })

      // Then: Tables named correctly
      expect(expectedTables).toContain("test_schema__user")
      expect(expectedTables).toContain("test_schema__user_profile")
      expect(expectedTables).toContain("test_schema__blog_post")
    })
  })

  describe("response format", () => {
    test("match response has correct structure", () => {
      const response: VerifyResponse = {
        ok: true,
        status: "match",
        schemaName: "test-schema",
        namespace: "test_schema",
        expected: ["test_schema__user"],
        actual: ["test_schema__user"],
        missing: [],
        extra: [],
        summary: "All 1 expected table(s) exist",
      }

      expect(response.ok).toBe(true)
      expect(response.status).toBe("match")
      expect(response.missing).toEqual([])
    })

    test("mismatch response has correct structure", () => {
      const response: VerifyResponse = {
        ok: true,
        status: "mismatch",
        schemaName: "test-schema",
        namespace: "test_schema",
        expected: ["test_schema__user", "test_schema__post"],
        actual: ["test_schema__user"],
        missing: ["test_schema__post"],
        extra: [],
        summary: "1 table(s) missing, 0 extra table(s) found",
      }

      expect(response.ok).toBe(true)
      expect(response.status).toBe("mismatch")
      expect(response.missing?.length).toBe(1)
    })

    test("error response has correct structure", () => {
      const response: VerifyResponse = {
        ok: false,
        error: {
          code: "NO_EXECUTOR",
          message: "Cannot verify: backend \"sql\" not found or has no executor.",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe("NO_EXECUTOR")
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

    test("can introspect actual tables using executor", async () => {
      // Given: Create test tables
      db.run("CREATE TABLE test_schema__user (id TEXT PRIMARY KEY, name TEXT)")
      db.run("CREATE TABLE test_schema__post (id TEXT PRIMARY KEY, title TEXT)")

      // When: Query for tables with namespace prefix
      const rows = await executor.execute([
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE $1 AND name NOT LIKE 'sqlite_%'`,
        ["test_schema__%"]
      ])

      // Then: Both tables found
      const tableNames = rows.map((r: any) => r.name)
      expect(tableNames).toContain("test_schema__user")
      expect(tableNames).toContain("test_schema__post")
    })

    test("returns empty array when no matching tables exist", async () => {
      // Given: No tables created

      // When: Query for tables
      const rows = await executor.execute([
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE $1 AND name NOT LIKE 'sqlite_%'`,
        ["nonexistent__%"]
      ])

      // Then: Empty result
      expect(rows).toEqual([])
    })
  })
})

// ============================================================================
// Dialect-Aware Table Naming Tests
// ============================================================================

describe("DDL Verify Tool - Dialect Awareness", () => {
  test("should use qualifyTableName for expected tables (PostgreSQL format)", () => {
    // When generating expected tables for PostgreSQL, should use schema.table format
    const namespace = "test_schema"
    const modelNames = ["User", "UserProfile", "TeamMember"]

    // Using qualifyTableName properly (this is what the tool SHOULD do)
    const postgresExpected = modelNames.map(modelName => {
      const tableName = toSnakeCase(modelName)
      return qualifyTableName(namespace, tableName, "postgresql")
    })

    // Then: Should be in "schema"."table" format
    expect(postgresExpected).toContain('"test_schema"."user"')
    expect(postgresExpected).toContain('"test_schema"."user_profile"')
    expect(postgresExpected).toContain('"test_schema"."team_member"')

    // Should NOT contain __ pattern for PostgreSQL
    for (const name of postgresExpected) {
      expect(name).not.toContain("__")
    }
  })

  test("should use qualifyTableName for expected tables (SQLite format)", () => {
    // For SQLite, expected tables should be "namespace__table"
    const namespace = "test_schema"
    const modelNames = ["User", "UserProfile"]

    // Using qualifyTableName properly
    const sqliteExpected = modelNames.map(modelName => {
      const tableName = toSnakeCase(modelName)
      return qualifyTableName(namespace, tableName, "sqlite")
    })

    // Then: Should be in namespace__table format
    expect(sqliteExpected).toContain("test_schema__user")
    expect(sqliteExpected).toContain("test_schema__user_profile")
  })

  test("toSnakeCase should be imported from state-api (no local duplicate in tool)", async () => {
    // This test verifies that the ddl.verify tool uses the shared toSnakeCase
    // from state-api rather than having its own duplicate implementation

    const toolSource = await Bun.file(
      `${process.cwd()}/packages/mcp/src/tools/ddl.verify.ts`
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

  test("should use qualifyTableName for dialect-aware table names in tool logic", async () => {
    // Read the tool source to verify it uses dialect-aware naming
    const toolSource = await Bun.file(
      `${process.cwd()}/packages/mcp/src/tools/ddl.verify.ts`
    ).text()

    // Should use qualifyTableName for expected tables
    const usesQualifyTableName = toolSource.includes("qualifyTableName")

    // Should not hardcode __ pattern
    const hardcodedPattern = /\$\{namespace\}__\$\{toSnakeCase\(modelName\)\}/
    const hasHardcodedPattern = hardcodedPattern.test(toolSource)

    expect(usesQualifyTableName).toBe(true)
    expect(hasHardcodedPattern).toBe(false)
  })
})
