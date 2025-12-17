/**
 * Unit tests for DDL constraint builder
 *
 * Tests inference of PRIMARY KEY, FOREIGN KEY, NOT NULL, and CHECK constraints
 * from Enhanced JSON Schema metadata.
 *
 * Generated from TestSpecifications:
 * - test-constraint-001: Infer primary key from identifier property
 * - test-constraint-002: Error when no identifier found
 * - test-constraint-004: NOT NULL inference from required array
 * - test-constraint-003: Infer foreign key from reference property
 * - test-constraint-005: CHECK constraint for enum properties
 */

import { describe, test, expect } from "bun:test"
import {
  inferPrimaryKey,
  inferNotNull,
  inferForeignKey,
  inferCheckConstraint,
} from "../constraint-builder"
import type { ForeignKeyDef } from "../types"

describe("inferPrimaryKey", () => {
  /**
   * Test: test-constraint-001
   * Scenario: Infer primary key from identifier property
   * Given: Model with property having x-mst-type: 'identifier'
   * When: inferPrimaryKey is called
   * Then: Returns the identifier property, Identifier is marked as NOT NULL
   */
  test("returns the identifier property", () => {
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
      },
      required: ["name"],
    }

    const result = inferPrimaryKey(model)

    expect(result).toBeDefined()
    expect(result.name).toBe("id")
    expect(result["x-mst-type"]).toBe("identifier")
  })

  /**
   * Test: test-constraint-002
   * Scenario: Error when no identifier found
   * Given: Model with no property having x-mst-type: 'identifier'
   * When: inferPrimaryKey is called
   * Then: Throws error with message about missing identifier
   */
  test("throws error when no identifier found", () => {
    const model = {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        email: {
          type: "string",
        },
      },
      required: ["name"],
    }

    expect(() => inferPrimaryKey(model)).toThrow(/identifier/i)
  })

  test("throws error when multiple identifiers exist", () => {
    const model = {
      type: "object",
      properties: {
        id: {
          type: "string",
          "x-mst-type": "identifier",
        },
        uuid: {
          type: "string",
          "x-mst-type": "identifier",
        },
        name: {
          type: "string",
        },
      },
      required: ["name"],
    }

    expect(() => inferPrimaryKey(model)).toThrow(/multiple.*identifier/i)
  })
})

describe("inferNotNull", () => {
  /**
   * Test: test-constraint-004
   * Scenario: NOT NULL inference from required array
   * Given: Property 'name' in required array, Property 'description' not in required array
   * When: inferNotNull is called for each property
   * Then: Returns true for 'name' (in required), Returns false for 'description' (not in required)
   */
  test("returns true for property in required array", () => {
    const property = {
      name: "name",
      type: "string",
    }
    const required = ["name", "email"]

    const result = inferNotNull(property, required)

    expect(result).toBe(true)
  })

  test("returns false for property not in required array", () => {
    const property = {
      name: "description",
      type: "string",
    }
    const required = ["name", "email"]

    const result = inferNotNull(property, required)

    expect(result).toBe(false)
  })

  test("identifier properties always return true regardless of required array", () => {
    const property = {
      name: "id",
      type: "string",
      "x-mst-type": "identifier",
    }
    const required: string[] = [] // Empty required array

    const result = inferNotNull(property, required)

    expect(result).toBe(true)
  })
})

describe("inferForeignKey", () => {
  /**
   * Test: test-constraint-003
   * Scenario: Infer foreign key from reference property
   * Given: Property with x-reference-type: 'single' and x-reference-target: 'Organization', Property is in required array
   * When: inferForeignKey is called
   * Then: Returns ForeignKeyDef, Column name is 'organization_id', onDelete is 'CASCADE' for required reference, Constraint name format is 'fk_{table}_{column}'
   */
  test("returns ForeignKeyDef for single reference property", () => {
    const property = {
      name: "organizationId",
      type: "string",
      "x-mst-type": "reference",
      "x-reference-type": "single",
      "x-reference-target": "Organization",
    }
    const modelName = "Team"
    const required = ["organizationId"]

    const result = inferForeignKey(property, modelName, required)

    expect(result).toBeDefined()
    expect(result?.column).toBe("organization_id")
    expect(result?.referencesTable).toBe("organization")  // snake_case
    expect(result?.referencesColumn).toBe("id")
    expect(result?.onDelete).toBe("CASCADE")
    expect(result?.name).toBe("fk_team_organization_id")  // snake_case
    expect(result?.table).toBe("team")  // snake_case
  })

  test("returns SET NULL for optional reference", () => {
    const property = {
      name: "managerId",
      type: "string",
      "x-mst-type": "maybe-reference",
      "x-reference-type": "single",
      "x-reference-target": "User",
    }
    const modelName = "Team"
    const required: string[] = [] // managerId not required

    const result = inferForeignKey(property, modelName, required)

    expect(result).toBeDefined()
    expect(result?.onDelete).toBe("SET NULL")
  })

  test("returns null for non-reference property", () => {
    const property = {
      name: "name",
      type: "string",
    }
    const modelName = "Team"
    const required = ["name"]

    const result = inferForeignKey(property, modelName, required)

    expect(result).toBeNull()
  })

  test("returns null for array reference (many-to-many)", () => {
    const property = {
      name: "members",
      type: "array",
      "x-reference-type": "array",
      "x-reference-target": "User",
      "x-computed": false,
    }
    const modelName = "Team"
    const required: string[] = []

    const result = inferForeignKey(property, modelName, required)

    expect(result).toBeNull()
  })

  test("skips computed properties", () => {
    const property = {
      name: "teams",
      type: "array",
      "x-reference-type": "array",
      "x-reference-target": "Team",
      "x-computed": true,
    }
    const modelName = "User"
    const required: string[] = []

    const result = inferForeignKey(property, modelName, required)

    expect(result).toBeNull()
  })
})

describe("inferCheckConstraint", () => {
  /**
   * Test: test-constraint-005
   * Scenario: CHECK constraint for enum properties
   * Given: Property 'status' with enum: ['active', 'inactive', 'pending']
   * When: inferCheckConstraint is called
   * Then: Returns CHECK constraint clause, Constraint format: 'status IN ('active', 'inactive', 'pending')'
   */
  test("returns CHECK constraint for enum property", () => {
    const property = {
      name: "status",
      type: "string",
      enum: ["active", "inactive", "pending"],
    }

    const result = inferCheckConstraint(property)

    expect(result).toBeDefined()
    expect(result).toContain("status")
    expect(result).toContain("IN")
    expect(result).toContain("'active'")
    expect(result).toContain("'inactive'")
    expect(result).toContain("'pending'")
  })

  test("returns null for non-enum property", () => {
    const property = {
      name: "description",
      type: "string",
    }

    const result = inferCheckConstraint(property)

    expect(result).toBeNull()
  })

  test("skips computed properties", () => {
    const property = {
      name: "computedStatus",
      type: "string",
      enum: ["active", "inactive"],
      "x-computed": true,
    }

    const result = inferCheckConstraint(property)

    expect(result).toBeNull()
  })
})
