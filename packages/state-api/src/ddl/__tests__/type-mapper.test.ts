/**
 * Unit tests for type-mapper.ts
 *
 * Generated from TestSpecifications for task-ddl-type-mapper
 * Tests JSON Schema type to SQL type mapping with dialect-aware translation
 */

import { describe, test, expect } from "bun:test"
import { mapPropertyType } from "../type-mapper"
import { createPostgresDialect, createSqliteDialect } from "../dialect"

describe("type-mapper", () => {
  /**
   * Test Specification: test-type-mapper-001
   * Scenario: Map string type without format
   *
   * Given: mapPropertyType function is available
   *        Property with type: 'string' and no format
   * When: mapPropertyType is called with the property and dialect
   * Then: Returns 'TEXT' for both PostgreSQL and SQLite
   */
  describe("Map string type without format", () => {
    test("returns TEXT for PostgreSQL", () => {
      const property = { type: "string" }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("TEXT")
    })

    test("returns TEXT for SQLite", () => {
      const property = { type: "string" }
      const dialect = createSqliteDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("TEXT")
    })
  })

  /**
   * Test Specification: test-type-mapper-002
   * Scenario: Map UUID type with dialect differences
   *
   * Given: Property with type: 'string' and format: 'uuid'
   *        PostgresDialect and SqliteDialect available
   * When: mapPropertyType is called
   * Then: Returns 'UUID' for PostgreSQL
   *       Returns 'TEXT' for SQLite
   */
  describe("Map UUID type with dialect differences", () => {
    test("returns UUID for PostgreSQL", () => {
      const property = { type: "string", format: "uuid" }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("UUID")
    })

    test("returns TEXT for SQLite", () => {
      const property = { type: "string", format: "uuid" }
      const dialect = createSqliteDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("TEXT")
    })
  })

  /**
   * Test Specification: test-type-mapper-003
   * Scenario: Map array of primitives to JSONB or TEXT
   *
   * Given: Property with type: 'array' of primitive items
   * When: mapPropertyType is called
   * Then: Returns 'JSONB' for PostgreSQL
   *       Returns 'TEXT' for SQLite
   */
  describe("Map array of primitives to JSONB or TEXT", () => {
    test("returns JSONB for PostgreSQL", () => {
      const property = { type: "array", items: { type: "string" } }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("JSONB")
    })

    test("returns TEXT for SQLite", () => {
      const property = { type: "array", items: { type: "string" } }
      const dialect = createSqliteDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("TEXT")
    })
  })

  /**
   * Additional acceptance criteria tests
   */
  describe("Additional type mappings", () => {
    test("maps integer to INTEGER for both dialects", () => {
      const property = { type: "integer" }
      const pgDialect = createPostgresDialect()
      const sqliteDialect = createSqliteDialect()

      expect(mapPropertyType(property, pgDialect)).toBe("INTEGER")
      expect(mapPropertyType(property, sqliteDialect)).toBe("INTEGER")
    })

    test("maps number to DOUBLE PRECISION for PostgreSQL", () => {
      const property = { type: "number" }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("DOUBLE PRECISION")
    })

    test("maps number to REAL for SQLite", () => {
      const property = { type: "number" }
      const dialect = createSqliteDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("REAL")
    })

    test("maps boolean using dialect.mapType() for PostgreSQL", () => {
      const property = { type: "boolean" }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("BOOLEAN")
    })

    test("maps boolean using dialect.mapType() for SQLite", () => {
      const property = { type: "boolean" }
      const dialect = createSqliteDialect()

      const result = mapPropertyType(property, dialect)

      expect(result).toBe("INTEGER")
    })

    test("maps string with date-time format using dialect.mapType()", () => {
      const property = { type: "string", format: "date-time" }
      const pgDialect = createPostgresDialect()
      const sqliteDialect = createSqliteDialect()

      expect(mapPropertyType(property, pgDialect)).toBe("TIMESTAMPTZ")
      expect(mapPropertyType(property, sqliteDialect)).toBe("TEXT")
    })
  })

  /**
   * Enum handling with checkConstraint flag
   * Per acceptance criteria: "Handles enum with checkConstraint flag"
   */
  describe("Enum handling", () => {
    test("returns base type for enum properties", () => {
      const property = {
        type: "string",
        enum: ["active", "inactive", "pending"]
      }
      const dialect = createPostgresDialect()

      const result = mapPropertyType(property, dialect)

      // Enum handling returns the base type
      // The CHECK constraint will be handled by constraint-builder
      expect(result).toBe("TEXT")
    })
  })
})
