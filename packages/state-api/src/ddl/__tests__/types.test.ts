/**
 * Generated from TestSpecifications for task-ddl-types
 * Tests core TypeScript interface definitions for DDL generator
 */

import { describe, test, expect } from "bun:test"

// This will fail if types.ts doesn't exist or exports are missing
import * as typesModule from "../types"
import type {
  DDLOutput,
  TableDef,
  ColumnDef,
  ForeignKeyDef,
  SqlDialect,
} from "../types"

describe("DDLOutput interface structure", () => {
  test("interface includes required properties with correct types", () => {
    // Given: TypeScript compiler is available and types.ts module is defined
    // When: DDLOutput interface is imported
    // Then: Interface includes all required properties

    // Verify the module exports exist
    expect(typesModule).toBeDefined()

    // Create a mock object that satisfies the DDLOutput interface
    const mockOutput: DDLOutput = {
      tables: [],
      foreignKeys: [],
      junctionTables: [],
      executionOrder: [],
    }

    // Verify the structure compiles and has expected properties
    expect(mockOutput).toHaveProperty("tables")
    expect(mockOutput).toHaveProperty("foreignKeys")
    expect(mockOutput).toHaveProperty("junctionTables")
    expect(mockOutput).toHaveProperty("executionOrder")

    // Type assertions to verify array types
    expect(Array.isArray(mockOutput.tables)).toBe(true)
    expect(Array.isArray(mockOutput.foreignKeys)).toBe(true)
    expect(Array.isArray(mockOutput.junctionTables)).toBe(true)
    expect(Array.isArray(mockOutput.executionOrder)).toBe(true)
  })
})

describe("TableDef interface structure", () => {
  test("interface includes required properties", () => {
    // Given: types.ts module is defined
    // When: TableDef interface is imported
    // Then: Interface includes name, columns, primaryKey, foreignKeys

    const mockTable: TableDef = {
      name: "users",
      columns: [],
      primaryKey: "id",
      foreignKeys: [],
    }

    expect(mockTable).toHaveProperty("name")
    expect(mockTable).toHaveProperty("columns")
    expect(mockTable).toHaveProperty("primaryKey")
    expect(mockTable).toHaveProperty("foreignKeys")

    expect(typeof mockTable.name).toBe("string")
    expect(Array.isArray(mockTable.columns)).toBe(true)
    expect(Array.isArray(mockTable.foreignKeys)).toBe(true)
  })

  test("ColumnDef interface includes required properties", () => {
    // Extended test for ColumnDef which is part of TableDef
    const mockColumn: ColumnDef = {
      name: "email",
      type: "TEXT",
      nullable: false,
    }

    expect(mockColumn).toHaveProperty("name")
    expect(mockColumn).toHaveProperty("type")
    expect(mockColumn).toHaveProperty("nullable")

    // Test optional properties compile
    const columnWithOptionals: ColumnDef = {
      name: "status",
      type: "TEXT",
      nullable: true,
      defaultValue: "'active'",
      checkConstraint: "status IN ('active', 'inactive')",
    }

    expect(columnWithOptionals).toHaveProperty("defaultValue")
    expect(columnWithOptionals).toHaveProperty("checkConstraint")
  })

  test("ForeignKeyDef interface includes required properties", () => {
    // Extended test for ForeignKeyDef
    const mockFk: ForeignKeyDef = {
      name: "fk_users_organization_id",
      table: "users",
      column: "organization_id",
      referencesTable: "organizations",
      referencesColumn: "id",
      onDelete: "CASCADE",
    }

    expect(mockFk).toHaveProperty("name")
    expect(mockFk).toHaveProperty("table")
    expect(mockFk).toHaveProperty("column")
    expect(mockFk).toHaveProperty("referencesTable")
    expect(mockFk).toHaveProperty("referencesColumn")
    expect(mockFk).toHaveProperty("onDelete")

    expect(typeof mockFk.name).toBe("string")
    expect(typeof mockFk.onDelete).toBe("string")
  })
})

describe("SqlDialect interface structure", () => {
  test("interface includes required properties and methods", () => {
    // Given: types.ts module is defined
    // When: SqlDialect interface is imported
    // Then: Interface includes name, escapeIdentifier, mapType, feature flags

    const mockDialect: SqlDialect = {
      name: "postgresql",
      escapeIdentifier: (name: string) => `"${name}"`,
      mapType: (jsonType: string, format?: string) => "TEXT",
      supportsForeignKeys: true,
      supportsCheckConstraints: true,
      supportsAddColumn: true,
      supportsDropColumn: true,
      supportsAlterColumnType: true,
      requiresTableRecreation: () => false,
    }

    expect(mockDialect).toHaveProperty("name")
    expect(mockDialect).toHaveProperty("escapeIdentifier")
    expect(mockDialect).toHaveProperty("mapType")
    expect(mockDialect).toHaveProperty("supportsForeignKeys")
    expect(mockDialect).toHaveProperty("supportsCheckConstraints")

    expect(typeof mockDialect.name).toBe("string")
    expect(typeof mockDialect.escapeIdentifier).toBe("function")
    expect(typeof mockDialect.mapType).toBe("function")
    expect(typeof mockDialect.supportsForeignKeys).toBe("boolean")
    expect(typeof mockDialect.supportsCheckConstraints).toBe("boolean")

    // Test method signatures
    const escaped = mockDialect.escapeIdentifier("user_name")
    expect(typeof escaped).toBe("string")

    const mapped = mockDialect.mapType("string", "uuid")
    expect(typeof mapped).toBe("string")

    // Test optional format parameter
    const mappedWithoutFormat = mockDialect.mapType("integer")
    expect(typeof mappedWithoutFormat).toBe("string")
  })
})
