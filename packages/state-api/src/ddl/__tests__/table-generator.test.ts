/**
 * Unit tests for DDL table generator
 *
 * Tests generation of CREATE TABLE statements with columns, constraints,
 * and foreign keys from Enhanced JSON Schema models.
 *
 * Generated from TestSpecifications:
 * - test-table-gen-001: Generate CREATE TABLE with columns and constraints
 * - test-table-gen-002: Skip computed properties
 */

import { describe, test, expect } from "bun:test"
import { generateCreateTable } from "../table-generator"
import { createPostgresDialect } from "../dialect"
import type { TableDef } from "../types"

describe("generateCreateTable", () => {
  /**
   * Test: test-table-gen-001
   * Scenario: Generate CREATE TABLE with columns and constraints
   * Given: Organization model with id (identifier), name (string), createdAt (date-time)
   * When: generateCreateTable is called with PostgreSQL dialect
   * Then:
   *   - Returns TableDef with name 'Organization'
   *   - Includes column 'id' with type 'UUID' and PRIMARY KEY
   *   - Includes column 'name' with type 'TEXT'
   *   - Includes column 'createdAt' with type 'TIMESTAMPTZ'
   *   - Table name matches model name (no pluralization)
   */
  test("generates CREATE TABLE with columns and constraints", () => {
    const model = {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          "x-mst-type": "identifier",
        },
        name: {
          type: "string",
        },
        createdAt: {
          type: "string",
          format: "date-time",
        },
      },
      required: ["name"],
    }
    const modelName = "Organization"
    const dialect = createPostgresDialect()

    const result: TableDef = generateCreateTable(model, modelName, dialect)

    // Table name is snake_case (matches query executor expectations)
    expect(result.name).toBe("organization")

    // Primary key is 'id'
    expect(result.primaryKey).toBe("id")

    // Check columns
    expect(result.columns).toHaveLength(3)

    // id column (UUID, NOT NULL, PRIMARY KEY)
    const idColumn = result.columns.find((col) => col.name === "id")
    expect(idColumn).toBeDefined()
    expect(idColumn?.type).toBe("UUID")
    expect(idColumn?.nullable).toBe(false)

    // name column (TEXT, NOT NULL because in required array)
    const nameColumn = result.columns.find((col) => col.name === "name")
    expect(nameColumn).toBeDefined()
    expect(nameColumn?.type).toBe("TEXT")
    expect(nameColumn?.nullable).toBe(false)

    // createdAt column (TIMESTAMPTZ, nullable)
    const createdAtColumn = result.columns.find(
      (col) => col.name === "created_at"
    )
    expect(createdAtColumn).toBeDefined()
    expect(createdAtColumn?.type).toBe("TIMESTAMPTZ")
    expect(createdAtColumn?.nullable).toBe(true)
  })

  /**
   * Test: test-table-gen-002
   * Scenario: Skip computed properties
   * Given: Model with property having x-computed: true
   * When: generateCreateTable is called
   * Then:
   *   - Computed property is not included in column list
   *   - Only stored properties generate columns
   */
  test("skips computed properties", () => {
    const model = {
      type: "object",
      properties: {
        id: {
          type: "string",
          "x-mst-type": "identifier",
        },
        name: {
          type: "string",
        },
        teams: {
          type: "array",
          "x-reference-type": "array",
          "x-reference-target": "Team",
          "x-computed": true, // This is a computed inverse relationship
        },
      },
      required: ["name"],
    }
    const modelName = "Organization"
    const dialect = createPostgresDialect()

    const result: TableDef = generateCreateTable(model, modelName, dialect)

    // Should only have 2 columns (id, name), not 3
    expect(result.columns).toHaveLength(2)

    // Verify computed property 'teams' is not in columns
    const teamsColumn = result.columns.find((col) => col.name === "teams")
    expect(teamsColumn).toBeUndefined()

    // Verify stored properties are present
    expect(result.columns.find((col) => col.name === "id")).toBeDefined()
    expect(result.columns.find((col) => col.name === "name")).toBeDefined()
  })
})
