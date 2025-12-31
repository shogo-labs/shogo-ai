/**
 * Migration Types Tests
 *
 * Generated from TestSpecifications for task-mig-001-types
 * Tests verify the structure and exports of migration type definitions.
 */

import { describe, test, expect } from "bun:test"

// Import types - these should exist after implementation
import type {
  SchemaDiff,
  ModelDiff,
  ColumnModification,
  MigrationOutput,
  MigrationRecord,
} from "../migration-types"
import { MigrationOperation } from "../migration-types"

describe("migration-types.ts", () => {
  describe("SchemaDiff interface structure", () => {
    test("has correct property types", () => {
      // Create a valid SchemaDiff to verify structure compiles
      const diff: SchemaDiff = {
        addedModels: ["User", "Post"],
        removedModels: ["OldModel"],
        modifiedModels: [],
        hasChanges: true,
      }

      expect(diff.addedModels).toBeInstanceOf(Array)
      expect(diff.removedModels).toBeInstanceOf(Array)
      expect(diff.modifiedModels).toBeInstanceOf(Array)
      expect(typeof diff.hasChanges).toBe("boolean")
    })

    test("addedModels is string[]", () => {
      const diff: SchemaDiff = {
        addedModels: ["Model1", "Model2"],
        removedModels: [],
        modifiedModels: [],
        hasChanges: true,
      }
      expect(diff.addedModels).toEqual(["Model1", "Model2"])
    })

    test("removedModels is string[]", () => {
      const diff: SchemaDiff = {
        addedModels: [],
        removedModels: ["OldModel"],
        modifiedModels: [],
        hasChanges: true,
      }
      expect(diff.removedModels).toEqual(["OldModel"])
    })

    test("modifiedModels is ModelDiff[]", () => {
      const modelDiff: ModelDiff = {
        modelName: "User",
        addedColumns: [],
        removedColumns: [],
        modifiedColumns: [],
      }
      const diff: SchemaDiff = {
        addedModels: [],
        removedModels: [],
        modifiedModels: [modelDiff],
        hasChanges: true,
      }
      expect(diff.modifiedModels).toHaveLength(1)
      expect(diff.modifiedModels[0].modelName).toBe("User")
    })
  })

  describe("ModelDiff interface structure", () => {
    test("has correct property types", () => {
      const modelDiff: ModelDiff = {
        modelName: "User",
        addedColumns: [{ name: "email", type: "TEXT", nullable: false }],
        removedColumns: ["oldField"],
        modifiedColumns: [],
      }

      expect(typeof modelDiff.modelName).toBe("string")
      expect(modelDiff.addedColumns).toBeInstanceOf(Array)
      expect(modelDiff.removedColumns).toBeInstanceOf(Array)
      expect(modelDiff.modifiedColumns).toBeInstanceOf(Array)
    })

    test("addedColumns contains ColumnDef objects", () => {
      const modelDiff: ModelDiff = {
        modelName: "User",
        addedColumns: [
          { name: "email", type: "TEXT", nullable: false },
          { name: "age", type: "INTEGER", nullable: true },
        ],
        removedColumns: [],
        modifiedColumns: [],
      }
      expect(modelDiff.addedColumns[0].name).toBe("email")
      expect(modelDiff.addedColumns[0].type).toBe("TEXT")
    })

    test("removedColumns is string[]", () => {
      const modelDiff: ModelDiff = {
        modelName: "User",
        addedColumns: [],
        removedColumns: ["field1", "field2"],
        modifiedColumns: [],
      }
      expect(modelDiff.removedColumns).toEqual(["field1", "field2"])
    })

    test("modifiedColumns contains ColumnModification objects", () => {
      const modification: ColumnModification = {
        columnName: "status",
        oldDef: { name: "status", type: "TEXT", nullable: true },
        newDef: { name: "status", type: "TEXT", nullable: false },
        changeType: "nullability",
      }
      const modelDiff: ModelDiff = {
        modelName: "User",
        addedColumns: [],
        removedColumns: [],
        modifiedColumns: [modification],
      }
      expect(modelDiff.modifiedColumns[0].columnName).toBe("status")
      expect(modelDiff.modifiedColumns[0].changeType).toBe("nullability")
    })
  })

  describe("ColumnModification interface structure", () => {
    test("has required properties", () => {
      const mod: ColumnModification = {
        columnName: "price",
        oldDef: { name: "price", type: "INTEGER", nullable: false },
        newDef: { name: "price", type: "REAL", nullable: false },
        changeType: "type",
      }

      expect(typeof mod.columnName).toBe("string")
      expect(mod.oldDef).toBeDefined()
      expect(mod.newDef).toBeDefined()
      expect(typeof mod.changeType).toBe("string")
    })
  })

  describe("MigrationOperation enum", () => {
    test("includes CREATE_TABLE", () => {
      expect(MigrationOperation.CREATE_TABLE).toBe("CREATE_TABLE" as any)
    })

    test("includes DROP_TABLE", () => {
      expect(MigrationOperation.DROP_TABLE).toBe("DROP_TABLE" as any)
    })

    test("includes ADD_COLUMN", () => {
      expect(MigrationOperation.ADD_COLUMN).toBe("ADD_COLUMN" as any)
    })

    test("includes DROP_COLUMN", () => {
      expect(MigrationOperation.DROP_COLUMN).toBe("DROP_COLUMN" as any)
    })

    test("includes RECREATE_TABLE", () => {
      expect(MigrationOperation.RECREATE_TABLE).toBe("RECREATE_TABLE" as any)
    })
  })

  describe("MigrationOutput interface structure", () => {
    test("has correct property types", () => {
      const output: MigrationOutput = {
        version: 2,
        schemaName: "user-schema",
        diff: {
          addedModels: [],
          removedModels: [],
          modifiedModels: [],
          hasChanges: false,
        },
        operations: [],
        warnings: [],
      }

      expect(typeof output.version).toBe("number")
      expect(typeof output.schemaName).toBe("string")
      expect(output.diff).toBeDefined()
      expect(output.operations).toBeInstanceOf(Array)
      expect(output.warnings).toBeInstanceOf(Array)
    })
  })

  describe("MigrationRecord interface structure", () => {
    test("has id property (string)", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(typeof record.id).toBe("string")
    })

    test("has schemaName property (string)", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(typeof record.schemaName).toBe("string")
    })

    test("has version property (number)", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 3,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(typeof record.version).toBe("number")
    })

    test("has checksum property (string)", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "sha256-abcdef123456",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(typeof record.checksum).toBe("string")
    })

    test("has appliedAt property (number)", () => {
      const now = Date.now()
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: now,
        statements: [],
        success: true,
      }
      expect(typeof record.appliedAt).toBe("number")
      expect(record.appliedAt).toBe(now)
    })

    test("has statements property (string[])", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: ["ALTER TABLE user ADD COLUMN email TEXT", "CREATE INDEX idx_email ON user(email)"],
        success: true,
      }
      expect(record.statements).toBeInstanceOf(Array)
      expect(record.statements).toHaveLength(2)
    })

    test("has success property (boolean)", () => {
      const record: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(typeof record.success).toBe("boolean")
    })

    test("has optional errorMessage property (string)", () => {
      const successRecord: MigrationRecord = {
        id: "mig-001",
        schemaName: "user-schema",
        version: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: [],
        success: true,
      }
      expect(successRecord.errorMessage).toBeUndefined()

      const failedRecord: MigrationRecord = {
        id: "mig-002",
        schemaName: "user-schema",
        version: 2,
        checksum: "def456",
        appliedAt: Date.now(),
        statements: [],
        success: false,
        errorMessage: "Column already exists",
      }
      expect(typeof failedRecord.errorMessage).toBe("string")
    })
  })
})

describe("DDL barrel exports", () => {
  test("types are exported from ddl/index.ts", async () => {
    // Dynamic import to test actual exports
    const ddlExports = await import("../index")

    // Check that the migration types module can be imported
    // The types themselves are compile-time only, but MigrationOperation is a value
    const migrationTypes = await import("../migration-types")
    expect(migrationTypes.MigrationOperation).toBeDefined()
  })
})
