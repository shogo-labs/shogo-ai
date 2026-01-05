/**
 * DDL Default Value E2E Tests
 *
 * Tests the full pipeline: JSON Schema with defaults → migration SQL with DEFAULT clauses
 *
 * This validates that defaults flow through:
 * 1. Meta-store ingestion
 * 2. Schema reconstruction (toEnhancedJson)
 * 3. Diff detection (compareSchemas)
 * 4. SQL generation (migrationOutputToSQL)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createMetaStore } from "../../meta/meta-store"
import { compareSchemas } from "../diff"
import { migrationOutputToSQL } from "../migration-generator"
import { createSqliteDialect } from "../dialect"
import { MigrationOperation } from "../migration-types"
import type { MigrationOutput, SchemaDiff } from "../migration-types"

describe("DDL Default Value E2E", () => {
  let metaStore: any

  beforeEach(() => {
    const { createStore } = createMetaStore()
    metaStore = createStore()
  })

  describe("Adding column with default", () => {
    test("string default generates quoted DEFAULT clause", () => {
      // V1: Task with just id
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" }
            },
            required: ["id"]
          }
        }
      }

      // V2: Task with id + status (with default)
      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      // Ingest and reconstruct via meta-store
      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1" })
      const v1Enhanced = v1Result.toEnhancedJson

      // Ingest v2 as a new schema (different name to avoid update logic)
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2" })
      const v2Enhanced = v2Result.toEnhancedJson

      // Compare schemas
      const diff = compareSchemas(v1Enhanced, v2Enhanced)

      // Find the Task model diff
      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      // Find the added status column
      const statusCol = taskDiff!.addedColumns.find(c => c.name === "status")
      expect(statusCol).toBeDefined()
      expect(statusCol!.defaultValue).toBe("'pending'")

      // Generate SQL with correct MigrationOutput structure
      const migration: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff,
        operations: [{
          type: MigrationOperation.ADD_COLUMN,
          tableName: "Task",
          column: {
            name: "status",
            type: "TEXT",
            nullable: true,
            defaultValue: "'pending'"
          }
        }],
        warnings: []
      }

      const dialect = createSqliteDialect()
      const sql = migrationOutputToSQL(migration, dialect)

      expect(sql.join("\n")).toContain("DEFAULT 'pending'")
    })

    test("integer default generates unquoted DEFAULT clause", () => {
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" }
            },
            required: ["id"]
          }
        }
      }

      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              priority: { type: "integer", default: 0 }
            },
            required: ["id"]
          }
        }
      }

      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1-int" })
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2-int" })

      const diff = compareSchemas(v1Result.toEnhancedJson, v2Result.toEnhancedJson)

      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      const priorityCol = taskDiff!.addedColumns.find(c => c.name === "priority")
      expect(priorityCol).toBeDefined()
      expect(priorityCol!.defaultValue).toBe("0")

      const migration: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff,
        operations: [{
          type: MigrationOperation.ADD_COLUMN,
          tableName: "Task",
          column: {
            name: "priority",
            type: "INTEGER",
            nullable: true,
            defaultValue: "0"
          }
        }],
        warnings: []
      }

      const dialect = createSqliteDialect()
      const sql = migrationOutputToSQL(migration, dialect)

      expect(sql.join("\n")).toContain("DEFAULT 0")
    })

    test("boolean default generates 0/1 for SQLite", () => {
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" }
            },
            required: ["id"]
          }
        }
      }

      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              isActive: { type: "boolean", default: true }
            },
            required: ["id"]
          }
        }
      }

      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1-bool" })
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2-bool" })

      const diff = compareSchemas(v1Result.toEnhancedJson, v2Result.toEnhancedJson)

      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      const isActiveCol = taskDiff!.addedColumns.find(c => c.name === "is_active")
      expect(isActiveCol).toBeDefined()
      expect(isActiveCol!.defaultValue).toBe("1")

      const migration: MigrationOutput = {
        version: 2,
        schemaName: "test",
        diff,
        operations: [{
          type: MigrationOperation.ADD_COLUMN,
          tableName: "Task",
          column: {
            name: "is_active",
            type: "INTEGER",
            nullable: true,
            defaultValue: "1"
          }
        }],
        warnings: []
      }

      const dialect = createSqliteDialect()
      const sql = migrationOutputToSQL(migration, dialect)

      expect(sql.join("\n")).toContain("DEFAULT 1")
    })
  })

  describe("Default value changes", () => {
    test("diff detects default value mutation", () => {
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "active" }
            },
            required: ["id"]
          }
        }
      }

      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1-mutate" })
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2-mutate" })

      const diff = compareSchemas(v1Result.toEnhancedJson, v2Result.toEnhancedJson)

      // Find the Task model diff
      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      // Column should be marked as mutated with default change
      const statusMod = taskDiff!.modifiedColumns.find(c => c.columnName === "status")
      expect(statusMod).toBeDefined()
      expect(statusMod!.changeType).toBe("default")
      expect(statusMod!.oldDef.defaultValue).toBe("'pending'")
      expect(statusMod!.newDef.defaultValue).toBe("'active'")
    })

    test("diff detects default value removal", () => {
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string" }  // No default
            },
            required: ["id"]
          }
        }
      }

      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1-remove" })
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2-remove" })

      const diff = compareSchemas(v1Result.toEnhancedJson, v2Result.toEnhancedJson)

      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      const statusMod = taskDiff!.modifiedColumns.find(c => c.columnName === "status")
      expect(statusMod).toBeDefined()
      expect(statusMod!.changeType).toBe("default")
      expect(statusMod!.oldDef.defaultValue).toBe("'pending'")
      expect(statusMod!.newDef.defaultValue).toBeUndefined()
    })

    test("diff detects default value addition", () => {
      const v1Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string" }  // No default
            },
            required: ["id"]
          }
        }
      }

      const v2Schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const v1Result = metaStore.ingestEnhancedJsonSchema(v1Schema, { name: "v1-add" })
      const v2Result = metaStore.ingestEnhancedJsonSchema(v2Schema, { name: "v2-add" })

      const diff = compareSchemas(v1Result.toEnhancedJson, v2Result.toEnhancedJson)

      const taskDiff = diff.modifiedModels.find(m => m.modelName === "Task")
      expect(taskDiff).toBeDefined()

      const statusMod = taskDiff!.modifiedColumns.find(c => c.columnName === "status")
      expect(statusMod).toBeDefined()
      expect(statusMod!.changeType).toBe("default")
      expect(statusMod!.oldDef.defaultValue).toBeUndefined()
      expect(statusMod!.newDef.defaultValue).toBe("'pending'")
    })
  })
})
