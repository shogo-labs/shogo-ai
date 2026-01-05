/**
 * Migration Generator Tests
 *
 * Generated from TestSpecifications for task-mig-005-generator
 * Tests generateMigration() and migrationOutputToSQL() functions.
 */

import { describe, test, expect } from "bun:test"
import { generateMigration, migrationOutputToSQL } from "../migration-generator"
import { compareSchemas } from "../diff"
import { createPostgresDialect, createSqliteDialect } from "../dialect"
import { MigrationOperation } from "../migration-types"
import type { SchemaDiff, MigrationOutput } from "../migration-types"

// Helper to create a minimal Enhanced JSON Schema
function createSchema(defs: Record<string, any>, required?: Record<string, string[]>) {
  const definitions: Record<string, any> = {}
  for (const [name, props] of Object.entries(defs)) {
    definitions[name] = {
      type: "object",
      properties: props,
      ...(required?.[name] && { required: required[name] }),
    }
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $defs: definitions,
  }
}

describe("migration-generator.ts - generateMigration()", () => {
  describe("Generate ADD_COLUMN operations for new columns", () => {
    test("creates ADD_COLUMN operation for new email column", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      const addColumnOps = output.operations.filter(
        (op) => op.type === MigrationOperation.ADD_COLUMN
      )
      expect(addColumnOps.length).toBeGreaterThan(0)
      const emailOp = addColumnOps.find((op) => op.column?.name === "email")
      expect(emailOp).toBeDefined()
      expect(emailOp!.tableName).toBe("user")
    })
  })

  describe("Generate DROP_COLUMN operations with warning", () => {
    test("creates DROP_COLUMN operation with data loss warning", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, legacyField: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      const dropColumnOps = output.operations.filter(
        (op) => op.type === MigrationOperation.DROP_COLUMN
      )
      expect(dropColumnOps.length).toBeGreaterThan(0)

      const legacyOp = dropColumnOps.find((op) => op.columnName === "legacyField")
      expect(legacyOp).toBeDefined()

      expect(output.warnings.some((w) => w.toLowerCase().includes("data loss"))).toBe(true)
    })
  })

  describe("Generate CREATE_TABLE operations for new models", () => {
    test("creates CREATE_TABLE operation for new Post model", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      const createTableOps = output.operations.filter(
        (op) => op.type === MigrationOperation.CREATE_TABLE
      )
      expect(createTableOps.length).toBeGreaterThan(0)

      const postOp = createTableOps.find((op) => op.tableName === "post")
      expect(postOp).toBeDefined()
    })
  })

  describe("Generate DROP_TABLE operations with warning", () => {
    test("creates DROP_TABLE operation with data loss warning", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
        LegacyModel: { id: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      const dropTableOps = output.operations.filter(
        (op) => op.type === MigrationOperation.DROP_TABLE
      )
      expect(dropTableOps.length).toBeGreaterThan(0)

      expect(output.warnings.some((w) => w.toLowerCase().includes("data loss"))).toBe(true)
    })
  })

  describe("Generate RECREATE_TABLE when dialect requires it", () => {
    test("generates RECREATE_TABLE for SQLite DROP_COLUMN", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createSqliteDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      const recreateOps = output.operations.filter(
        (op) => op.type === MigrationOperation.RECREATE_TABLE
      )
      expect(recreateOps.length).toBeGreaterThan(0)

      const dropColumnOps = output.operations.filter(
        (op) => op.type === MigrationOperation.DROP_COLUMN
      )
      expect(dropColumnOps.length).toBe(0)
    })
  })

  describe("Warning for new non-nullable column without default", () => {
    test("adds warning for required column without default", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const newSchema = createSchema(
        {
          User: { id: { type: "string" }, code: { type: "string" } },
        },
        { User: ["id", "code"] } // code is required
      )
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      expect(output.warnings.some((w) =>
        w.toLowerCase().includes("nullable") || w.toLowerCase().includes("default")
      )).toBe(true)
    })
  })

  describe("Warning for lossy type changes", () => {
    test("adds warning for type change from string to integer", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, count: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, count: { type: "integer" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })

      expect(output.warnings.some((w) =>
        w.toLowerCase().includes("type") && (w.toLowerCase().includes("lossy") || w.toLowerCase().includes("change"))
      )).toBe(true)
    })
  })
})

describe("migration-generator.ts - migrationOutputToSQL()", () => {
  describe("PostgreSQL ADD COLUMN SQL generation", () => {
    test("generates correct ALTER TABLE ADD COLUMN", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.ADD_COLUMN,
            tableName: "user",
            column: { name: "email", type: "TEXT", nullable: false },
          },
        ],
        warnings: [],
      }
      const dialect = createPostgresDialect()

      const statements = migrationOutputToSQL(output, dialect)

      expect(statements.some((s) => s.includes("ALTER TABLE"))).toBe(true)
      expect(statements.some((s) => s.includes("ADD COLUMN"))).toBe(true)
      expect(statements.some((s) => s.includes("email"))).toBe(true)
      expect(statements.some((s) => s.includes("NOT NULL"))).toBe(true)
    })
  })

  describe("SQLite ADD COLUMN SQL generation", () => {
    test("generates correct ALTER TABLE ADD COLUMN for SQLite", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.ADD_COLUMN,
            tableName: "user",
            column: { name: "email", type: "TEXT", nullable: true },
          },
        ],
        warnings: [],
      }
      const dialect = createSqliteDialect()

      const statements = migrationOutputToSQL(output, dialect)

      expect(statements.some((s) => s.includes("ALTER TABLE"))).toBe(true)
      expect(statements.some((s) => s.includes("ADD COLUMN"))).toBe(true)
    })
  })

  describe("PostgreSQL DROP COLUMN SQL generation", () => {
    test("generates correct ALTER TABLE DROP COLUMN", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.DROP_COLUMN,
            tableName: "user",
            columnName: "legacyField",
          },
        ],
        warnings: [],
      }
      const dialect = createPostgresDialect()

      const statements = migrationOutputToSQL(output, dialect)

      expect(statements.some((s) => s.includes("ALTER TABLE"))).toBe(true)
      expect(statements.some((s) => s.includes("DROP COLUMN"))).toBe(true)
    })
  })

  describe("RECREATE_TABLE generates 4-step SQLite pattern", () => {
    test("generates CREATE temp, INSERT SELECT, DROP original, RENAME", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.RECREATE_TABLE,
            tableName: "user",
            columns: [
              { name: "id", type: "TEXT", nullable: false },
              { name: "name", type: "TEXT", nullable: true },
            ],
          },
        ],
        warnings: [],
      }
      const dialect = createSqliteDialect()

      const statements = migrationOutputToSQL(output, dialect)

      // Step 1: CREATE TABLE temp
      expect(statements.some((s) => s.includes("CREATE TABLE") && s.includes("_new"))).toBe(true)
      // Step 2: INSERT INTO ... SELECT
      expect(statements.some((s) => s.includes("INSERT INTO") && s.includes("SELECT"))).toBe(true)
      // Step 3: DROP TABLE original
      expect(statements.some((s) => s.includes("DROP TABLE") && s.includes('"user"'))).toBe(true)
      // Step 4: RENAME
      expect(statements.some((s) => s.includes("ALTER TABLE") && s.includes("RENAME TO"))).toBe(true)
    })
  })

  describe("INSERT SELECT handles new columns with defaults", () => {
    test("uses default value for new column in SELECT", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.RECREATE_TABLE,
            tableName: "user",
            columns: [
              { name: "id", type: "TEXT", nullable: false },
              { name: "status", type: "TEXT", nullable: false, defaultValue: "'active'" },
            ],
          },
        ],
        warnings: [],
      }
      const dialect = createSqliteDialect()

      const statements = migrationOutputToSQL(output, dialect)

      // Should include default value in INSERT SELECT
      expect(statements.some((s) =>
        s.includes("INSERT INTO") && (s.includes("'active'") || s.includes("active"))
      )).toBe(true)
    })
  })

  describe("Transaction wrapping statements generated", () => {
    test("includes BEGIN and COMMIT statements", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.ADD_COLUMN,
            tableName: "user",
            column: { name: "email", type: "TEXT", nullable: true },
          },
        ],
        warnings: [],
      }
      const dialect = createPostgresDialect()

      const statements = migrationOutputToSQL(output, dialect)

      expect(statements[0]).toMatch(/^BEGIN/i)
      expect(statements[statements.length - 1]).toMatch(/^COMMIT/i)
    })
  })

  describe("CREATE_TABLE SQL generation for added models", () => {
    test("generates CREATE TABLE with columns for new model", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" }, views: { type: "integer" } },
      }, { Post: ["id", "title"] })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, { schemaName: "test", version: 2 })
      const statements = migrationOutputToSQL(output, dialect)

      // Should generate actual CREATE TABLE, not a comment
      const createStmt = statements.find(s => s.includes("CREATE TABLE") && !s.startsWith("--"))
      expect(createStmt).toBeDefined()
      expect(createStmt).toContain('"post"')
      expect(createStmt).toContain('"id"')
      expect(createStmt).toContain('"title"')
      expect(createStmt).toContain('"views"')
      expect(createStmt).toContain("NOT NULL")
    })

    test("generates CREATE TABLE with reference as TEXT column", () => {
      const oldSchema = createSchema({ Task: { id: { type: "string" } } })
      const newSchema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        $defs: {
          Task: { type: "object", properties: { id: { type: "string" } } },
          Comment: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              task: { $ref: "#/$defs/Task", "x-mst-type": "reference" },
            },
            required: ["id", "text", "task"],
          },
        },
      }
      const diff = compareSchemas(oldSchema, newSchema)
      const statements = migrationOutputToSQL(
        generateMigration(diff, createPostgresDialect(), { schemaName: "test", version: 2 }),
        createPostgresDialect()
      )

      const createStmt = statements.find(s => s.includes("CREATE TABLE") && s.includes("comment"))
      expect(createStmt).toBeDefined()
      expect(createStmt).toContain('"task"')
      expect(createStmt).toContain("TEXT")
    })

    test("generates CREATE TABLE with default values", () => {
      const oldSchema = createSchema({})
      const newSchema = createSchema({
        Item: { id: { type: "string" }, status: { type: "string", default: "pending" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const statements = migrationOutputToSQL(
        generateMigration(diff, createPostgresDialect(), { schemaName: "test", version: 1 }),
        createPostgresDialect()
      )

      const createStmt = statements.find(s => s.includes("CREATE TABLE"))
      expect(createStmt).toContain("DEFAULT 'pending'")
    })

    test("generates CREATE TABLE with namespace prefix for PostgreSQL", () => {
      const oldSchema = createSchema({})
      const newSchema = createSchema({
        Item: { id: { type: "string" }, name: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "test",
        version: 1,
        namespace: "my_ns",
      })
      const statements = migrationOutputToSQL(output, dialect)

      const createStmt = statements.find(s => s.includes("CREATE TABLE"))
      expect(createStmt).toContain('"my_ns"."item"')
    })
  })
})

describe("DDL barrel exports", () => {
  test("generateMigration and migrationOutputToSQL exported from index", async () => {
    const { generateMigration: gen, migrationOutputToSQL: toSql } = await import("../index")
    expect(typeof gen).toBe("function")
    expect(typeof toSql).toBe("function")
  })
})

describe("namespace handling in migrations", () => {
  describe("generateMigration applies namespace to table names", () => {
    test("PostgreSQL: uses namespace.table format for ALTER TABLE", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "my-schema",
        namespace: "my_schema",
        version: 2,
      })

      // Expect operations to use namespaced table name (unescaped - escaping in SQL generation)
      const addColumnOps = output.operations.filter(
        (op) => op.type === MigrationOperation.ADD_COLUMN
      )
      expect(addColumnOps.length).toBeGreaterThan(0)
      // PostgreSQL format: namespace.table (dot separator)
      expect(addColumnOps[0].tableName).toBe("my_schema.user")
    })

    test("SQLite: uses namespace__table format for ALTER TABLE", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createSqliteDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "my-schema",
        namespace: "my_schema",
        version: 2,
      })

      // Expect operations to use namespaced table name
      const addColumnOps = output.operations.filter(
        (op) => op.type === MigrationOperation.ADD_COLUMN
      )
      expect(addColumnOps.length).toBeGreaterThan(0)
      // SQLite format: namespace__table
      expect(addColumnOps[0].tableName).toBe("my_schema__user")
    })

    test("CREATE_TABLE uses namespaced table name", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createSqliteDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "test-schema",
        namespace: "test_schema",
        version: 2,
      })

      const createTableOps = output.operations.filter(
        (op) => op.type === MigrationOperation.CREATE_TABLE
      )
      expect(createTableOps.length).toBeGreaterThan(0)
      expect(createTableOps[0].tableName).toBe("test_schema__post")
    })

    test("DROP_TABLE uses namespaced table name", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" } },
        LegacyModel: { id: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createPostgresDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "app-schema",
        namespace: "app_schema",
        version: 2,
      })

      const dropTableOps = output.operations.filter(
        (op) => op.type === MigrationOperation.DROP_TABLE
      )
      expect(dropTableOps.length).toBeGreaterThan(0)
      // PostgreSQL format: namespace.table (dot separator, unescaped)
      expect(dropTableOps[0].tableName).toBe("app_schema.legacy_model")
    })

    test("RECREATE_TABLE uses namespaced table name for SQLite", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } },
      })
      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })
      const diff = compareSchemas(oldSchema, newSchema)
      const dialect = createSqliteDialect()

      const output = generateMigration(diff, dialect, {
        schemaName: "my-app",
        namespace: "my_app",
        version: 2,
      })

      const recreateOps = output.operations.filter(
        (op) => op.type === MigrationOperation.RECREATE_TABLE
      )
      expect(recreateOps.length).toBeGreaterThan(0)
      expect(recreateOps[0].tableName).toBe("my_app__user")
    })
  })

  describe("migrationOutputToSQL escapes namespaced table names correctly", () => {
    test("PostgreSQL: escapes namespace.table as separate identifiers", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.ADD_COLUMN,
            tableName: "my_schema.user", // unescaped namespace.table
            column: { name: "email", type: "TEXT", nullable: false },
          },
        ],
        warnings: [],
      }
      const dialect = createPostgresDialect()

      const statements = migrationOutputToSQL(output, dialect)

      // Should escape as "my_schema"."user" (each part separately)
      const alterStatement = statements.find((s) => s.includes("ALTER TABLE"))
      expect(alterStatement).toBeDefined()
      expect(alterStatement).toContain('"my_schema"."user"')
    })

    test("SQLite: escapes namespace__table as single identifier", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff: { addedModels: [], addedModelDefs: {}, removedModels: [], modifiedModels: [], hasChanges: true },
        operations: [
          {
            type: MigrationOperation.ADD_COLUMN,
            tableName: "my_schema__user", // underscore-separated
            column: { name: "email", type: "TEXT", nullable: true },
          },
        ],
        warnings: [],
      }
      const dialect = createSqliteDialect()

      const statements = migrationOutputToSQL(output, dialect)

      // Should escape as "my_schema__user" (single identifier)
      const alterStatement = statements.find((s) => s.includes("ALTER TABLE"))
      expect(alterStatement).toBeDefined()
      expect(alterStatement).toContain('"my_schema__user"')
    })
  })
})
