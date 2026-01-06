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

// ============================================================================
// Layer 5: Mutation SQL Generation Utilities (RED Tests)
// ============================================================================

import {
  entityToColumns,
  buildInsertSQL,
  buildUpdateSQL,
  buildDeleteSQL,
  createPropertyColumnMap,
  normalizeRowWithTypes,
} from "../utils"

describe("createPropertyColumnMap (inverse of createColumnPropertyMap)", () => {
  /**
   * Test Spec: test-mutation-utils-01
   * Scenario: Create mapping from property names to column names
   *
   * Inverse of createColumnPropertyMap - maps property → column
   * for use in INSERT/UPDATE statements.
   */
  test("creates mapping from property names to column names", () => {
    // Given: Array of property names from schema
    const propertyNames = ["userId", "createdAt", "isActive", "name"]

    // When: createPropertyColumnMap is called
    const map = createPropertyColumnMap(propertyNames)

    // Then: Returns mapping from camelCase property to snake_case column
    expect(map).toEqual({
      userId: "user_id",
      createdAt: "created_at",
      isActive: "is_active",
      name: "name",
    })
  })

  test("handles consecutive capitals correctly", () => {
    // Given: Property names with consecutive capitals
    const propertyNames = ["HTTPSUrl", "XMLParser", "userID", "ID"]

    // When: createPropertyColumnMap is called
    const map = createPropertyColumnMap(propertyNames)

    // Then: Uses DDL toSnakeCase algorithm
    expect(map.HTTPSUrl).toBe("https_url")
    expect(map.XMLParser).toBe("xml_parser")
    expect(map.userID).toBe("user_id")
    expect(map.ID).toBe("id")
  })
})

describe("entityToColumns", () => {
  /**
   * Test Spec: test-mutation-utils-02
   * Scenario: Convert camelCase entity to snake_case columns
   */
  test("converts camelCase properties to snake_case columns", () => {
    // Given: Entity with camelCase properties
    const entity = {
      id: "123",
      userName: "alice",
      createdAt: "2024-01-01",
      isActive: true,
    }

    // When: entityToColumns is called
    const result = entityToColumns(entity)

    // Then: Returns object with snake_case keys
    expect(result).toEqual({
      id: "123",
      user_name: "alice",
      created_at: "2024-01-01",
      is_active: true,
    })
  })

  test("uses explicit mapping when provided", () => {
    // Given: Entity and explicit property-to-column mapping
    const entity = { HTTPSUrl: "https://example.com", userID: "usr_123" }
    const propertyColumnMap = {
      HTTPSUrl: "https_url",
      userID: "user_id",
    }

    // When: entityToColumns is called with mapping
    const result = entityToColumns(entity, propertyColumnMap)

    // Then: Uses provided mapping for correct column names
    expect(result).toEqual({
      https_url: "https://example.com",
      user_id: "usr_123",
    })
  })

  test("handles null and undefined values", () => {
    // Given: Entity with null/undefined values
    const entity = { name: "test", email: null, phone: undefined }

    // When: entityToColumns is called
    const result = entityToColumns(entity)

    // Then: Preserves null, excludes undefined
    expect(result.name).toBe("test")
    expect(result.email).toBeNull()
    expect(result).not.toHaveProperty("phone")
  })

  test("handles empty entity", () => {
    expect(entityToColumns({})).toEqual({})
  })
})

// ============================================================================
// Array/Object JSON Serialization Tests
// ============================================================================

describe("entityToColumns - JSON serialization", () => {
  /**
   * Test Spec: test-json-serialize-01
   * Scenario: Arrays are serialized to JSON strings for SQL storage
   */
  test("serializes array values to JSON strings", () => {
    // Given: Entity with array properties
    const entity = {
      id: "123",
      tags: ["alpha", "beta"],
      applicablePatterns: ["enhancement-hooks"],
    }

    // When: entityToColumns is called
    const result = entityToColumns(entity)

    // Then: Array values are JSON-serialized strings
    expect(result.tags).toBe('["alpha","beta"]')
    expect(result.applicable_patterns).toBe('["enhancement-hooks"]')
    expect(typeof result.tags).toBe("string")
  })

  test("handles empty arrays", () => {
    const entity = { id: "123", tags: [] }
    const result = entityToColumns(entity)
    expect(result.tags).toBe("[]")
  })

  test("handles nested arrays", () => {
    const entity = { id: "123", matrix: [[1, 2], [3, 4]] }
    const result = entityToColumns(entity)
    expect(result.matrix).toBe("[[1,2],[3,4]]")
  })

  /**
   * Test Spec: test-json-serialize-02
   * Scenario: Objects are serialized to JSON strings for SQL storage
   */
  test("serializes object values to JSON strings", () => {
    const entity = {
      id: "123",
      metadata: { key: "value", nested: { deep: true } },
      initialAssessment: { complexity: "high" },
    }
    const result = entityToColumns(entity)
    expect(result.metadata).toBe('{"key":"value","nested":{"deep":true}}')
    expect(result.initial_assessment).toBe('{"complexity":"high"}')
    expect(typeof result.metadata).toBe("string")
  })

  test("handles empty objects", () => {
    const entity = { id: "123", metadata: {} }
    const result = entityToColumns(entity)
    expect(result.metadata).toBe("{}")
  })

  test("does NOT serialize Date objects", () => {
    const date = new Date("2024-01-01T00:00:00Z")
    const entity = { id: "123", createdAt: date }
    const result = entityToColumns(entity)
    // Date should pass through unchanged (not JSON-serialized)
    expect(result.created_at).toBe(date)
  })
})

describe("normalizeRowWithTypes - JSON deserialization", () => {
  /**
   * Test Spec: test-json-deserialize-01
   * Scenario: JSON strings are parsed back to arrays when propType is array
   */
  test("parses JSON strings back to arrays when propType is array", () => {
    // Given: Row from database with JSON string
    const row = {
      id: "123",
      tags: '["alpha","beta"]',
      applicable_patterns: '["enhancement-hooks"]',
    }
    const columnPropertyMap = {
      id: "id",
      tags: "tags",
      applicable_patterns: "applicablePatterns",
    }
    const propertyTypes = {
      id: "string",
      tags: "array",
      applicablePatterns: "array",
    }

    // When: normalizeRowWithTypes is called
    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)

    // Then: Array fields are parsed back to arrays
    expect(result.tags).toEqual(["alpha", "beta"])
    expect(result.applicablePatterns).toEqual(["enhancement-hooks"])
    expect(Array.isArray(result.tags)).toBe(true)
  })

  test("handles empty array JSON", () => {
    const row = { tags: "[]" }
    const columnPropertyMap = { tags: "tags" }
    const propertyTypes = { tags: "array" }

    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)
    expect(result.tags).toEqual([])
  })

  test("handles null array fields", () => {
    const row = { tags: null }
    const columnPropertyMap = { tags: "tags" }
    const propertyTypes = { tags: "array" }

    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)
    expect(result.tags).toBeUndefined()
  })

  test("handles malformed JSON gracefully", () => {
    const row = { tags: "not valid json" }
    const columnPropertyMap = { tags: "tags" }
    const propertyTypes = { tags: "array" }

    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)
    // Should preserve original value on parse failure
    expect(result.tags).toBe("not valid json")
  })

  /**
   * Test Spec: test-json-deserialize-02
   * Scenario: JSON strings are parsed back to objects when propType is object
   */
  test("parses JSON strings back to objects when propType is object", () => {
    const row = {
      id: "123",
      metadata: '{"key":"value","nested":{"deep":true}}',
      initial_assessment: '{"complexity":"high"}',
    }
    const columnPropertyMap = {
      id: "id",
      metadata: "metadata",
      initial_assessment: "initialAssessment",
    }
    const propertyTypes = {
      id: "string",
      metadata: "object",
      initialAssessment: "object",
    }

    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)
    expect(result.metadata).toEqual({ key: "value", nested: { deep: true } })
    expect(result.initialAssessment).toEqual({ complexity: "high" })
    expect(typeof result.metadata).toBe("object")
  })

  test("handles empty object JSON", () => {
    const row = { metadata: "{}" }
    const columnPropertyMap = { metadata: "metadata" }
    const propertyTypes = { metadata: "object" }

    const result = normalizeRowWithTypes(row, columnPropertyMap, "sqlite", propertyTypes)
    expect(result.metadata).toEqual({})
  })
})

describe("buildInsertSQL", () => {
  /**
   * Test Spec: test-mutation-utils-03
   * Scenario: Generate INSERT SQL for PostgreSQL
   */
  test("generates INSERT SQL for PostgreSQL", () => {
    // Given: Table name and column names
    const tableName = "users"
    const columns = ["id", "name", "status"]

    // When: buildInsertSQL is called for PostgreSQL
    const result = buildInsertSQL(tableName, columns, "pg")

    // Then: Generates correct INSERT syntax with $1, $2 placeholders
    expect(result).toContain('INSERT INTO "users"')
    expect(result).toContain('"id", "name", "status"')
    expect(result).toContain("VALUES ($1, $2, $3)")
    expect(result).toContain("RETURNING *")
  })

  test("generates INSERT SQL for SQLite", () => {
    // Given: Table name and column names
    const tableName = "users"
    const columns = ["id", "name", "status"]

    // When: buildInsertSQL is called for SQLite
    const result = buildInsertSQL(tableName, columns, "sqlite")

    // Then: Generates correct INSERT syntax with ? placeholders
    expect(result).toContain('INSERT INTO "users"')
    expect(result).toContain('"id", "name", "status"')
    expect(result).toContain("VALUES (?, ?, ?)")
    // SQLite doesn't support RETURNING in all versions
  })

  test("escapes identifiers correctly", () => {
    // Given: Table name with special characters
    const tableName = "user_roles"
    const columns = ["user_id", "role_id"]

    // When: buildInsertSQL is called
    const result = buildInsertSQL(tableName, columns, "pg")

    // Then: Identifiers are quoted
    expect(result).toContain('"user_roles"')
    expect(result).toContain('"user_id"')
    expect(result).toContain('"role_id"')
  })
})

describe("buildUpdateSQL", () => {
  /**
   * Test Spec: test-mutation-utils-04
   * Scenario: Generate UPDATE SQL
   */
  test("generates UPDATE SQL for PostgreSQL", () => {
    // Given: Table name, SET columns, and WHERE column
    const tableName = "users"
    const setColumns = ["name", "status"]
    const whereColumn = "id"

    // When: buildUpdateSQL is called for PostgreSQL
    const result = buildUpdateSQL(tableName, setColumns, whereColumn, "pg")

    // Then: Generates correct UPDATE syntax
    expect(result).toContain('UPDATE "users"')
    expect(result).toContain("SET")
    expect(result).toContain('"name" = $1')
    expect(result).toContain('"status" = $2')
    expect(result).toContain('WHERE "id" = $3')
    expect(result).toContain("RETURNING *")
  })

  test("generates UPDATE SQL for SQLite", () => {
    // Given: Table name, SET columns, and WHERE column
    const tableName = "users"
    const setColumns = ["name", "status"]
    const whereColumn = "id"

    // When: buildUpdateSQL is called for SQLite
    const result = buildUpdateSQL(tableName, setColumns, whereColumn, "sqlite")

    // Then: Generates correct UPDATE syntax with ? placeholders
    expect(result).toContain('UPDATE "users"')
    expect(result).toContain('"name" = ?')
    expect(result).toContain('"status" = ?')
    expect(result).toContain('WHERE "id" = ?')
  })

  test("handles single column update", () => {
    // Given: Single column to update
    const result = buildUpdateSQL("users", ["status"], "id", "pg")

    // Then: SET clause has single column
    expect(result).toContain('"status" = $1')
    expect(result).toContain('WHERE "id" = $2')
  })
})

describe("buildDeleteSQL", () => {
  /**
   * Test Spec: test-mutation-utils-05
   * Scenario: Generate DELETE SQL
   */
  test("generates DELETE SQL for PostgreSQL", () => {
    // Given: Table name and WHERE column
    const tableName = "users"
    const whereColumn = "id"

    // When: buildDeleteSQL is called for PostgreSQL
    const result = buildDeleteSQL(tableName, whereColumn, "pg")

    // Then: Generates correct DELETE syntax
    expect(result).toContain('DELETE FROM "users"')
    expect(result).toContain('WHERE "id" = $1')
  })

  test("generates DELETE SQL for SQLite", () => {
    // Given: Table name and WHERE column
    const tableName = "users"
    const whereColumn = "id"

    // When: buildDeleteSQL is called for SQLite
    const result = buildDeleteSQL(tableName, whereColumn, "sqlite")

    // Then: Generates correct DELETE syntax with ? placeholder
    expect(result).toContain('DELETE FROM "users"')
    expect(result).toContain('WHERE "id" = ?')
  })

  test("escapes identifiers correctly", () => {
    // Given: Table name with underscores
    const result = buildDeleteSQL("user_sessions", "session_id", "pg")

    // Then: Identifiers are quoted
    expect(result).toContain('"user_sessions"')
    expect(result).toContain('"session_id"')
  })
})
