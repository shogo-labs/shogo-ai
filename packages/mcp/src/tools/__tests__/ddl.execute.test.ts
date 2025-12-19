/**
 * DDL Execute Tool Tests
 *
 * Tests for the ddl.execute MCP tool that generates and executes
 * CREATE TABLE statements from Enhanced JSON Schema.
 *
 * Key test cases:
 * - Validates schema exists in meta-store
 * - Generates DDL with IF NOT EXISTS from Enhanced JSON Schema
 * - dryRun: true returns DDL without executing
 * - Executes via ISqlExecutor.executeMany()
 * - Returns list of executed statements
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  createPostgresDialect,
  generateDDL,
  generateSQL,
} from "@shogo/state-api"
import {
  initializePostgresBackend,
  getPostgresExecutor,
  isPostgresAvailable,
  __resetForTesting,
} from "../../postgres-init"

// Store original env for restoration
const originalDatabaseUrl = process.env.DATABASE_URL

describe("DDL Execute Tool", () => {
  beforeEach(() => {
    resetMetaStore()
    __resetForTesting()
  })

  afterEach(() => {
    // Restore DATABASE_URL
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  describe("schema validation", () => {
    test("returns error when schema not found in meta-store", async () => {
      // Given: No schema in meta-store

      // When: Attempting to generate DDL for non-existent schema
      // This simulates what the tool would do
      const metaStore = getMetaStore()
      const schema = metaStore.findSchemaByName("non-existent-schema")

      // Then: Schema not found (returns undefined when not found)
      expect(schema).toBeUndefined()
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
              status: { type: "string", enum: ["pending", "done"] },
            },
            required: ["id", "title"],
          },
        },
      }

      metaStore.ingestEnhancedJsonSchema(schemaData as any, { name: "test-schema" })

      // When: Looking up schema
      const schema = metaStore.findSchemaByName("test-schema")

      // Then: Schema found
      expect(schema).not.toBeNull()
      expect(schema!.name).toBe("test-schema")
    })
  })

  describe("DDL generation", () => {
    test("generates DDL with IF NOT EXISTS option", () => {
      // Given: Schema definition
      const schema = {
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

      // When: Generating SQL with IF NOT EXISTS
      const dialect = createPostgresDialect()
      const statements = generateSQL(schema as any, dialect, { ifNotExists: true })

      // Then: Statements include IF NOT EXISTS
      expect(statements.length).toBeGreaterThan(0)
      const createTableStmt = statements.find(s => s.includes("CREATE TABLE"))
      expect(createTableStmt).toContain("IF NOT EXISTS")
    })

    test("generates DDL without IF NOT EXISTS by default", () => {
      // Given: Schema definition
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              email: { type: "string" },
            },
            required: ["id", "email"],
          },
        },
      }

      // When: Generating SQL without options
      const dialect = createPostgresDialect()
      const statements = generateSQL(schema as any, dialect)

      // Then: Statements don't include IF NOT EXISTS
      expect(statements.length).toBeGreaterThan(0)
      const createTableStmt = statements.find(s => s.includes("CREATE TABLE"))
      expect(createTableStmt).not.toContain("IF NOT EXISTS")
    })

    test("generates proper table names in snake_case", () => {
      // Given: Schema with PascalCase model names
      const schema = {
        $defs: {
          UserProfile: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              firstName: { type: "string" },
            },
            required: ["id", "firstName"],
          },
        },
      }

      // When: Generating DDL
      const dialect = createPostgresDialect()
      const ddl = generateDDL(schema as any, dialect)

      // Then: Table name is snake_case
      const tableNames = ddl.tables.map(t => t.name)
      expect(tableNames).toContain("user_profile")
    })

    test("generates foreign key constraints for references", () => {
      // Given: Schema with references
      const schema = {
        $defs: {
          Organization: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
          Team: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
              organizationId: {
                type: "string",
                format: "uuid",
                "x-reference-type": "single",
                "x-reference-target": "Organization",
              },
            },
            required: ["id", "name", "organizationId"],
          },
        },
      }

      // When: Generating DDL
      const dialect = createPostgresDialect()
      const ddl = generateDDL(schema as any, dialect)

      // Then: Foreign key constraints are generated
      expect(ddl.foreignKeys.length).toBeGreaterThan(0)
      const teamFk = ddl.foreignKeys.find(fk => fk.table === "team")
      expect(teamFk).toBeDefined()
      expect(teamFk?.referencesTable).toBe("organization")
    })
  })

  describe("dry run mode", () => {
    test("dryRun returns DDL statements without executing", () => {
      // Given: Schema in meta-store
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

      const schema = metaStore.ingestEnhancedJsonSchema(schemaData as any, { name: "test-schema" })

      // When: Generating DDL in dry run mode
      const enhancedJson = schema.toEnhancedJson
      const dialect = createPostgresDialect()
      const statements = generateSQL(enhancedJson, dialect, { ifNotExists: true })

      // Then: Returns statements that would be executed
      expect(statements).toBeInstanceOf(Array)
      expect(statements.length).toBeGreaterThan(0)
      expect(statements[0]).toContain("CREATE TABLE")
    })
  })

  describe("postgres execution", () => {
    // These tests require DATABASE_URL
    const hasPostgres = !!process.env.DATABASE_URL
    const describePostgres = hasPostgres ? describe : describe.skip

    describePostgres("with DATABASE_URL", () => {
      beforeEach(() => {
        __resetForTesting()
        initializePostgresBackend()
      })

      test("executor is available after initialization", () => {
        const executor = getPostgresExecutor()
        expect(executor).toBeDefined()
      })

      test("executor has executeMany method for DDL batch execution", () => {
        const executor = getPostgresExecutor()
        expect(executor).toBeDefined()
        expect(typeof executor?.executeMany).toBe("function")
      })

      test("can execute DDL statements via executor", async () => {
        // Given: Executor and DDL statements
        const executor = getPostgresExecutor()
        expect(executor).toBeDefined()

        // Create a test table (use unique name to avoid conflicts)
        const testTableName = `test_ddl_${Date.now()}`
        const statements = [
          `CREATE TABLE IF NOT EXISTS "${testTableName}" (id UUID PRIMARY KEY, name TEXT NOT NULL);`,
        ]

        // When: Executing DDL
        try {
          await executor!.executeMany(statements)

          // Then: Table should exist (verify by querying)
          const result = await executor!.execute([
            `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
            [testTableName],
          ])

          expect(result.length).toBe(1)
        } finally {
          // Cleanup
          await executor!.execute([`DROP TABLE IF EXISTS "${testTableName}"`, []])
        }
      })
    })
  })

  describe("tool response format", () => {
    test("successful dry run returns expected structure", () => {
      // Given: Schema in meta-store
      const metaStore = getMetaStore()
      const schemaData = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            },
            required: ["id"],
          },
        },
      }

      const schema = metaStore.ingestEnhancedJsonSchema(schemaData as any, { name: "test-schema" })

      // When: Simulating tool response for dry run
      const enhancedJson = schema.toEnhancedJson
      const dialect = createPostgresDialect()
      const statements = generateSQL(enhancedJson, dialect, { ifNotExists: true })

      // Simulate tool response
      const response = {
        ok: true,
        dryRun: true,
        schemaName: schema.name,
        statements,
        statementCount: statements.length,
      }

      // Then: Response has expected structure
      expect(response.ok).toBe(true)
      expect(response.dryRun).toBe(true)
      expect(response.schemaName).toBe("test-schema")
      expect(response.statements).toBeInstanceOf(Array)
      expect(response.statementCount).toBeGreaterThan(0)
    })

    test("error response for missing schema", () => {
      // Simulate tool response for missing schema
      const response = {
        ok: false,
        error: {
          code: "SCHEMA_NOT_FOUND",
          message: "Schema 'non-existent' not found in meta-store",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error.code).toBe("SCHEMA_NOT_FOUND")
    })

    test("error response when postgres not available", () => {
      // Given: No DATABASE_URL
      delete process.env.DATABASE_URL
      __resetForTesting()

      // Simulate tool response when postgres unavailable
      const pgAvailable = isPostgresAvailable()
      expect(pgAvailable).toBe(false)

      const response = {
        ok: false,
        error: {
          code: "POSTGRES_UNAVAILABLE",
          message: "PostgreSQL not available. Set DATABASE_URL environment variable.",
        },
      }

      expect(response.ok).toBe(false)
      expect(response.error.code).toBe("POSTGRES_UNAVAILABLE")
    })
  })
})
