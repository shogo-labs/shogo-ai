/**
 * Tests for SQL dialect implementations
 *
 * Generated from TestSpecifications for task-ddl-dialect
 * Tests PostgreSQL and SQLite dialect type mappings and identifier escaping
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createPostgresDialect, createSqliteDialect } from "../dialect"
import type { SqlDialect } from "../types"

describe("PostgreSQL dialect", () => {
  let dialect: SqlDialect

  // Given: PostgresDialect is instantiated
  beforeEach(() => {
    dialect = createPostgresDialect()
  })

  // Test: test-dialect-001
  // When: mapType('string', 'uuid') is called
  // Then: Returns 'UUID'
  test("maps string+uuid to UUID", () => {
    const result = dialect.mapType("string", "uuid")
    expect(result).toBe("UUID")
  })

  // Test: test-dialect-002
  // When: mapType('string', 'date-time') is called
  // Then: Returns 'TIMESTAMPTZ'
  test("maps string+date-time to TIMESTAMPTZ", () => {
    const result = dialect.mapType("string", "date-time")
    expect(result).toBe("TIMESTAMPTZ")
  })

  // Additional type mappings for completeness
  test("maps integer to INTEGER", () => {
    const result = dialect.mapType("integer")
    expect(result).toBe("INTEGER")
  })

  test("maps number to DOUBLE PRECISION", () => {
    const result = dialect.mapType("number")
    expect(result).toBe("DOUBLE PRECISION")
  })

  test("maps boolean to BOOLEAN", () => {
    const result = dialect.mapType("boolean")
    expect(result).toBe("BOOLEAN")
  })

  // Test: test-dialect-003
  // When: escapeIdentifier('table"name') is called
  // Then: Returns '"table""name"' (internal quotes are doubled for escaping)
  test("escapes identifiers with double quotes and doubles internal quotes", () => {
    const result = dialect.escapeIdentifier('table"name')
    expect(result).toBe('"table""name"')
  })

  test("escapes simple identifiers with double quotes", () => {
    const result = dialect.escapeIdentifier("user_name")
    expect(result).toBe('"user_name"')
  })

  test("has correct dialect name", () => {
    expect(dialect.name).toBe("postgresql")
  })
})

describe("SQLite dialect", () => {
  let dialect: SqlDialect

  // Given: SqliteDialect is instantiated
  beforeEach(() => {
    dialect = createSqliteDialect()
  })

  // Test: test-dialect-004
  // When: mapType is called with different types
  // Then: Returns appropriate SQLite type fallbacks
  test("maps string+uuid to TEXT", () => {
    const result = dialect.mapType("string", "uuid")
    expect(result).toBe("TEXT")
  })

  test("maps string+date-time to TEXT", () => {
    const result = dialect.mapType("string", "date-time")
    expect(result).toBe("TEXT")
  })

  test("maps boolean to INTEGER", () => {
    const result = dialect.mapType("boolean")
    expect(result).toBe("INTEGER")
  })

  test("maps number to REAL", () => {
    const result = dialect.mapType("number")
    expect(result).toBe("REAL")
  })

  test("maps integer to INTEGER", () => {
    const result = dialect.mapType("integer")
    expect(result).toBe("INTEGER")
  })

  test("escapes identifiers with double quotes", () => {
    const result = dialect.escapeIdentifier("table_name")
    expect(result).toBe('"table_name"')
  })

  test("has correct dialect name", () => {
    expect(dialect.name).toBe("sqlite")
  })
})

// ============================================================================
// Migration Capability Tests (task-mig-004-dialect)
// ============================================================================

import { MigrationOperation } from "../migration-types"

describe("Migration Capabilities", () => {
  describe("Both dialects support ADD COLUMN", () => {
    test("PostgresDialect.supportsAddColumn is true", () => {
      const dialect = createPostgresDialect()
      expect(dialect.supportsAddColumn).toBe(true)
    })

    test("SqliteDialect.supportsAddColumn is true", () => {
      const dialect = createSqliteDialect()
      expect(dialect.supportsAddColumn).toBe(true)
    })
  })

  describe("DROP COLUMN support differs by dialect", () => {
    test("PostgresDialect.supportsDropColumn is true", () => {
      const dialect = createPostgresDialect()
      expect(dialect.supportsDropColumn).toBe(true)
    })

    test("SqliteDialect.supportsDropColumn is false", () => {
      const dialect = createSqliteDialect()
      expect(dialect.supportsDropColumn).toBe(false)
    })
  })

  describe("ALTER COLUMN TYPE support differs by dialect", () => {
    test("PostgresDialect.supportsAlterColumnType is true", () => {
      const dialect = createPostgresDialect()
      expect(dialect.supportsAlterColumnType).toBe(true)
    })

    test("SqliteDialect.supportsAlterColumnType is false", () => {
      const dialect = createSqliteDialect()
      expect(dialect.supportsAlterColumnType).toBe(false)
    })
  })

  describe("PostgresDialect never requires table recreation", () => {
    test("requiresTableRecreation returns false for ADD_COLUMN", () => {
      const dialect = createPostgresDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.ADD_COLUMN)).toBe(false)
    })

    test("requiresTableRecreation returns false for DROP_COLUMN", () => {
      const dialect = createPostgresDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.DROP_COLUMN)).toBe(false)
    })

    test("requiresTableRecreation returns false for CREATE_TABLE", () => {
      const dialect = createPostgresDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.CREATE_TABLE)).toBe(false)
    })
  })

  describe("SqliteDialect requires table recreation for unsupported operations", () => {
    test("requiresTableRecreation returns true for DROP_COLUMN", () => {
      const dialect = createSqliteDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.DROP_COLUMN)).toBe(true)
    })

    test("requiresTableRecreation returns true for RECREATE_TABLE", () => {
      const dialect = createSqliteDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.RECREATE_TABLE)).toBe(true)
    })

    test("requiresTableRecreation returns false for ADD_COLUMN", () => {
      const dialect = createSqliteDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.ADD_COLUMN)).toBe(false)
    })

    test("requiresTableRecreation returns false for CREATE_TABLE", () => {
      const dialect = createSqliteDialect()
      expect(dialect.requiresTableRecreation(MigrationOperation.CREATE_TABLE)).toBe(false)
    })
  })
})
