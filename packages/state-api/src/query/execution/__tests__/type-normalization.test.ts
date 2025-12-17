/**
 * Type-Aware Normalization Tests
 *
 * Tests for normalizeRowWithTypes function that handles dialect-specific
 * type conversions (e.g., SQLite INTEGER → boolean).
 */

import { describe, test, expect } from "bun:test"
import { normalizeRowWithTypes, normalizeRowsWithTypes } from "../utils"
import type { ColumnPropertyMap } from "../utils"

// ============================================================================
// NORM-01: normalizeRowWithTypes Function
// ============================================================================

describe("NORM-01: normalizeRowWithTypes", () => {
  const columnMap: ColumnPropertyMap = {
    is_active: "isActive",
    is_admin: "isAdmin",
    user_id: "userId",
    age: "age",
    name: "name"
  }

  // ==========================================================================
  // SQLite Boolean Conversion
  // ==========================================================================

  test("sqlite: converts INTEGER 1 to boolean true", () => {
    const row = { is_active: 1, user_id: "alice", age: 30 }
    const propertyTypes = {
      isActive: "boolean",
      userId: "string",
      age: "number"
    }

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    expect(result.isActive).toBe(true)
    expect(typeof result.isActive).toBe("boolean")
  })

  test("sqlite: converts INTEGER 0 to boolean false", () => {
    const row = { is_active: 0 }
    const propertyTypes = { isActive: "boolean" }

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    expect(result.isActive).toBe(false)
    expect(typeof result.isActive).toBe("boolean")
  })

  test("sqlite: handles multiple boolean columns", () => {
    const row = { is_active: 1, is_admin: 0 }
    const propertyTypes = {
      isActive: "boolean",
      isAdmin: "boolean"
    }

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    expect(result.isActive).toBe(true)
    expect(result.isAdmin).toBe(false)
  })

  // ==========================================================================
  // PostgreSQL Boolean Passthrough
  // ==========================================================================

  test("postgres: boolean values pass through unchanged", () => {
    const row = { is_active: true, is_admin: false }
    const propertyTypes = {
      isActive: "boolean",
      isAdmin: "boolean"
    }

    const result = normalizeRowWithTypes(row, columnMap, "pg", propertyTypes)

    expect(result.isActive).toBe(true)
    expect(result.isAdmin).toBe(false)
  })

  // ==========================================================================
  // Non-Boolean Types
  // ==========================================================================

  test("non-boolean types unaffected by dialect", () => {
    const row = { user_id: "test", age: 25, name: "Alice" }
    const propertyTypes = {
      userId: "string",
      age: "number",
      name: "string"
    }

    const sqliteResult = normalizeRowWithTypes(
      row,
      columnMap,
      "sqlite",
      propertyTypes
    )
    const pgResult = normalizeRowWithTypes(row, columnMap, "pg", propertyTypes)

    expect(sqliteResult).toEqual(pgResult)
    expect(sqliteResult.userId).toBe("test")
    expect(sqliteResult.age).toBe(25)
  })

  test("unknown property types use generic normalization", () => {
    const row = { some_field: "value" }
    const columnMap = { some_field: "someField" }
    const propertyTypes = {} // No type info

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    expect(result.someField).toBe("value")
  })

  test("missing type info for boolean property passes value through", () => {
    const row = { is_active: 1 }
    const propertyTypes = {} // No type info for isActive

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    // Without type info, value passes through as-is
    expect(result.isActive).toBe(1)
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  test("handles null values (converts to undefined for MST compatibility)", () => {
    const row = { is_active: null }
    const propertyTypes = { isActive: "boolean" }

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    // SQL NULL is converted to undefined for MST compatibility
    expect(result.isActive).toBeUndefined()
  })

  test("handles undefined values", () => {
    const row = { is_active: undefined }
    const propertyTypes = { isActive: "boolean" }

    const result = normalizeRowWithTypes(row, columnMap, "sqlite", propertyTypes)

    expect(result.isActive).toBeUndefined()
  })

  test("empty row returns empty object", () => {
    const result = normalizeRowWithTypes({}, columnMap, "sqlite", {})

    expect(result).toEqual({})
  })
})

// ============================================================================
// NORM-02: Batch Normalization
// ============================================================================

describe("NORM-02: normalizeRowsWithTypes (batch)", () => {
  const columnMap: ColumnPropertyMap = {
    id: "id",
    is_active: "isActive"
  }

  test("normalizes array of rows with type conversion", () => {
    const rows = [
      { id: "1", is_active: 1 },
      { id: "2", is_active: 0 },
      { id: "3", is_active: 1 }
    ]
    const propertyTypes = { id: "string", isActive: "boolean" }

    const result = normalizeRowsWithTypes(rows, columnMap, "sqlite", propertyTypes)

    expect(result).toHaveLength(3)
    expect(result[0].isActive).toBe(true)
    expect(result[1].isActive).toBe(false)
    expect(result[2].isActive).toBe(true)
  })

  test("handles empty array", () => {
    const result = normalizeRowsWithTypes([], columnMap, "sqlite", {})

    expect(result).toEqual([])
  })
})
