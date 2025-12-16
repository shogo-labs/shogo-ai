/**
 * Tests for SQL execution utility functions
 *
 * These utilities handle field name normalization between:
 * - snake_case (database convention)
 * - camelCase (JavaScript/MST convention)
 */

import { describe, test, expect } from "bun:test"
import {
  snakeToCamel,
  camelToSnake,
  normalizeRow,
  normalizeRows,
  createColumnPropertyMap,
  normalizeRowWithSchema,
  normalizeRowsWithSchema,
} from "../utils"

describe("snakeToCamel", () => {
  /**
   * Test Spec: test-p2-exec-utils-01
   * Scenario: snakeToCamel converts snake_case to camelCase
   */
  test("converts snake_case to camelCase", () => {
    // Given: snakeToCamel function is available
    // When: snakeToCamel('created_at') is called
    const result = snakeToCamel("created_at")

    // Then: Returns 'createdAt'
    expect(result).toBe("createdAt")

    // Then: Single underscores become camelCase boundaries
    expect(snakeToCamel("user_id")).toBe("userId")
    expect(snakeToCamel("first_name")).toBe("firstName")
    expect(snakeToCamel("is_active")).toBe("isActive")
  })

  /**
   * Test Spec: test-p2-exec-utils-02
   * Scenario: snakeToCamel handles edge cases
   */
  test("handles edge cases", () => {
    // Given: snakeToCamel function is available
    // When: snakeToCamel is called with edge case inputs

    // Then: Empty string returns empty string
    expect(snakeToCamel("")).toBe("")

    // Then: Single word 'name' returns 'name'
    expect(snakeToCamel("name")).toBe("name")

    // Then: Consecutive underscores 'foo__bar' handled correctly
    expect(snakeToCamel("foo__bar")).toBe("fooBar")

    // Then: Leading underscore '_private' handled correctly
    expect(snakeToCamel("_private")).toBe("Private")
  })
})

describe("camelToSnake", () => {
  /**
   * Test Spec: test-p2-exec-utils-03
   * Scenario: camelToSnake converts camelCase to snake_case
   */
  test("converts camelCase to snake_case", () => {
    // Given: camelToSnake function is available
    // When: camelToSnake('createdAt') is called
    const result = camelToSnake("createdAt")

    // Then: Returns 'created_at'
    expect(result).toBe("created_at")

    // Then: Capital letters become underscore + lowercase
    expect(camelToSnake("userId")).toBe("user_id")
    expect(camelToSnake("firstName")).toBe("first_name")
    expect(camelToSnake("isActive")).toBe("is_active")
  })

  test("handles edge cases", () => {
    expect(camelToSnake("")).toBe("")
    expect(camelToSnake("name")).toBe("name")
    expect(camelToSnake("ID")).toBe("i_d") // All caps
  })
})

describe("normalizeRow", () => {
  /**
   * Test Spec: test-p2-exec-utils-04
   * Scenario: normalizeRow transforms all keys to camelCase
   */
  test("transforms all keys to camelCase", () => {
    // Given: normalizeRow function is available
    // Given: Row object with snake_case keys
    const row = { user_id: 1, created_at: "2024-01-01" }

    // When: normalizeRow(row) is called
    const result = normalizeRow(row)

    // Then: Returns { userId: 1, createdAt: '2024-01-01' }
    expect(result).toEqual({
      userId: 1,
      createdAt: "2024-01-01",
    })

    // Then: Values are preserved unchanged
    expect(result.userId).toBe(1)
    expect(result.createdAt).toBe("2024-01-01")

    // Then: Original row is not mutated
    expect(row).toEqual({ user_id: 1, created_at: "2024-01-01" })
  })

  test("handles empty object", () => {
    expect(normalizeRow({})).toEqual({})
  })

  test("handles complex nested values", () => {
    const row = {
      user_id: 1,
      metadata: { nested: "value" },
      tags: ["a", "b"],
    }
    const result = normalizeRow(row)
    expect(result).toEqual({
      userId: 1,
      metadata: { nested: "value" },
      tags: ["a", "b"],
    })
  })
})

describe("normalizeRows", () => {
  /**
   * Test Spec: test-p2-exec-utils-05
   * Scenario: normalizeRows batch processes array of rows
   */
  test("batch processes array of rows", () => {
    // Given: normalizeRows function is available
    // Given: Array of rows with snake_case keys
    const rows = [
      { user_id: 1, created_at: "2024-01-01" },
      { user_id: 2, created_at: "2024-01-02" },
      { user_id: 3, created_at: "2024-01-03" },
    ]

    // When: normalizeRows(rows) is called
    const result = normalizeRows(rows)

    // Then: Returns array of same length
    expect(result).toHaveLength(rows.length)

    // Then: Each row has camelCase keys
    expect(result[0]).toEqual({ userId: 1, createdAt: "2024-01-01" })
    expect(result[1]).toEqual({ userId: 2, createdAt: "2024-01-02" })
    expect(result[2]).toEqual({ userId: 3, createdAt: "2024-01-03" })
  })

  test("handles empty array", () => {
    // Then: Empty array returns empty array
    expect(normalizeRows([])).toEqual([])
  })
})

// ============================================================================
// Schema-Aware Normalization Tests
// ============================================================================
// These tests verify correct round-trip behavior using schema property names
// as the source of truth, ensuring DDL column names map back correctly.

describe("createColumnPropertyMap", () => {
  /**
   * Test Spec: test-schema-norm-01
   * Scenario: Creates mapping from DDL column names to property names
   *
   * The mapping must use the SAME toSnakeCase algorithm as DDL generator
   * to ensure round-trip correctness.
   */
  test("creates mapping using DDL toSnakeCase algorithm", () => {
    // Given: Array of property names from schema
    const propertyNames = ["userId", "createdAt", "isActive", "name"]

    // When: createColumnPropertyMap is called
    const map = createColumnPropertyMap(propertyNames)

    // Then: Returns mapping from snake_case column to camelCase property
    expect(map).toEqual({
      user_id: "userId",
      created_at: "createdAt",
      is_active: "isActive",
      name: "name",
    })
  })

  /**
   * Test Spec: test-schema-norm-02
   * Scenario: Handles consecutive capitals (the critical edge case)
   *
   * DDL's toSnakeCase handles consecutive caps:
   * - HTTPSUrl → https_url (not h_t_t_p_s_url)
   * - XMLParser → xml_parser
   * - userID → user_id
   */
  test("handles consecutive capitals correctly (DDL algorithm)", () => {
    // Given: Property names with consecutive capitals
    const propertyNames = ["HTTPSUrl", "XMLParser", "userID", "apiURL", "ID"]

    // When: createColumnPropertyMap is called
    const map = createColumnPropertyMap(propertyNames)

    // Then: Mapping uses DDL's toSnakeCase algorithm
    // DDL: HTTPSUrl → https_url (insert _ before uppercase followed by lowercase)
    expect(map["https_url"]).toBe("HTTPSUrl")

    // DDL: XMLParser → xml_parser
    expect(map["xml_parser"]).toBe("XMLParser")

    // DDL: userID → user_id (trailing caps)
    expect(map["user_id"]).toBe("userID")

    // DDL: apiURL → api_url
    expect(map["api_url"]).toBe("apiURL")

    // DDL: ID → id (all caps, no underscores)
    expect(map["id"]).toBe("ID")
  })

  test("handles empty array", () => {
    expect(createColumnPropertyMap([])).toEqual({})
  })

  test("handles PascalCase model names", () => {
    // Given: Property names that start with uppercase (like model references)
    const propertyNames = ["Organization", "TeamMember", "HTTPSConnection"]

    // When: createColumnPropertyMap is called
    const map = createColumnPropertyMap(propertyNames)

    // Then: Mapping handles PascalCase correctly
    expect(map["organization"]).toBe("Organization")
    expect(map["team_member"]).toBe("TeamMember")
    expect(map["https_connection"]).toBe("HTTPSConnection")
  })
})

describe("normalizeRowWithSchema", () => {
  /**
   * Test Spec: test-schema-norm-03
   * Scenario: Uses schema mapping for correct property names
   */
  test("uses schema mapping for correct property names", () => {
    // Given: Column-to-property mapping
    const columnPropertyMap = {
      user_id: "userId",
      created_at: "createdAt",
      is_active: "isActive",
    }

    // Given: Database row with snake_case keys
    const row = { user_id: 1, created_at: "2024-01-01", is_active: true }

    // When: normalizeRowWithSchema is called
    const result = normalizeRowWithSchema(row, columnPropertyMap)

    // Then: Returns row with correct property names from schema
    expect(result).toEqual({
      userId: 1,
      createdAt: "2024-01-01",
      isActive: true,
    })
  })

  /**
   * Test Spec: test-schema-norm-04
   * Scenario: Consecutive capitals round-trip correctly
   *
   * This is the critical test that verifies the fix for the data corruption issue.
   */
  test("consecutive capitals round-trip correctly", () => {
    // Given: Mapping from DDL column names to original property names
    const columnPropertyMap = {
      https_url: "HTTPSUrl",
      xml_parser: "XMLParser",
      user_id: "userID",
      api_url: "apiURL",
      id: "ID",
    }

    // Given: Database row with snake_case columns (as DDL would create them)
    const row = {
      https_url: "https://example.com",
      xml_parser: "libxml2",
      user_id: "usr_123",
      api_url: "https://api.example.com",
      id: "entity_001",
    }

    // When: normalizeRowWithSchema is called
    const result = normalizeRowWithSchema(row, columnPropertyMap)

    // Then: Returns row with ORIGINAL property names (not generic camelCase)
    expect(result).toEqual({
      HTTPSUrl: "https://example.com",
      XMLParser: "libxml2",
      userID: "usr_123",
      apiURL: "https://api.example.com",
      ID: "entity_001",
    })

    // Critical assertions - these would FAIL with generic snakeToCamel:
    // - snakeToCamel("https_url") returns "httpsUrl" not "HTTPSUrl"
    // - snakeToCamel("user_id") returns "userId" not "userID"
    // - snakeToCamel("id") returns "id" not "ID"
    expect(result.HTTPSUrl).toBe("https://example.com")
    expect(result.userID).toBe("usr_123")
    expect(result.ID).toBe("entity_001")
  })

  /**
   * Test Spec: test-schema-norm-05
   * Scenario: Falls back to generic snakeToCamel for unmapped columns
   */
  test("falls back to generic snakeToCamel for unmapped columns", () => {
    // Given: Partial mapping (some columns not in schema)
    const columnPropertyMap = {
      user_id: "userId",
    }

    // Given: Row with columns not in mapping (e.g., database metadata)
    const row = {
      user_id: 1,
      created_at: "2024-01-01", // Not in mapping
      _internal_flag: true,     // Not in mapping
    }

    // When: normalizeRowWithSchema is called
    const result = normalizeRowWithSchema(row, columnPropertyMap)

    // Then: Mapped columns use schema names
    expect(result.userId).toBe(1)

    // Then: Unmapped columns fall back to generic snakeToCamel
    expect(result.createdAt).toBe("2024-01-01")
    expect(result.InternalFlag).toBe(true) // Leading underscore handled
  })

  test("preserves values unchanged", () => {
    const columnPropertyMap = { user_id: "userId" }
    const row = {
      user_id: { nested: "object" },
    }
    const result = normalizeRowWithSchema(row, columnPropertyMap)
    expect(result.userId).toEqual({ nested: "object" })
  })

  test("does not mutate original row", () => {
    const columnPropertyMap = { user_id: "userId" }
    const row = { user_id: 1 }
    normalizeRowWithSchema(row, columnPropertyMap)
    expect(row).toEqual({ user_id: 1 })
  })
})

describe("normalizeRowsWithSchema", () => {
  /**
   * Test Spec: test-schema-norm-06
   * Scenario: Batch processes rows with schema mapping
   */
  test("batch processes rows with schema mapping", () => {
    // Given: Column-to-property mapping with consecutive caps
    const columnPropertyMap = {
      id: "ID",
      user_id: "userID",
      https_url: "HTTPSUrl",
    }

    // Given: Array of database rows
    const rows = [
      { id: "1", user_id: "usr_1", https_url: "https://a.com" },
      { id: "2", user_id: "usr_2", https_url: "https://b.com" },
    ]

    // When: normalizeRowsWithSchema is called
    const result = normalizeRowsWithSchema(rows, columnPropertyMap)

    // Then: All rows are normalized with correct property names
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      ID: "1",
      userID: "usr_1",
      HTTPSUrl: "https://a.com",
    })
    expect(result[1]).toEqual({
      ID: "2",
      userID: "usr_2",
      HTTPSUrl: "https://b.com",
    })
  })

  test("handles empty array", () => {
    expect(normalizeRowsWithSchema([], {})).toEqual([])
  })
})
