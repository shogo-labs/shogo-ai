/**
 * Integration tests for DDL main API
 *
 * Tests the generateDDL() main entry point which orchestrates:
 * - Topological sorting for table creation order
 * - Table generation via table-generator
 * - Junction table generation via junction-generator
 * - Complete DDLOutput structure
 *
 * Generated from TestSpecification:
 * - test-main-api-001: Generate complete DDL output structure
 */

import { describe, test, expect } from "bun:test"
import { generateDDL } from "../index"
import { createPostgresDialect } from "../dialect"
import type { DDLOutput } from "../types"

describe("generateDDL", () => {
  /**
   * Test: test-main-api-001
   * Scenario: Generate complete DDL output structure
   * Given: Enhanced JSON Schema with Organization and Team models
   *        PostgreSQL dialect
   * When: generateDDL is called
   * Then:
   *   - Returns DDLOutput object
   *   - DDLOutput.tables contains TableDef for Organization and Team
   *   - DDLOutput.executionOrder is ['Organization', 'Team'] (topologically sorted)
   *   - DDLOutput.foreignKeys contains FK constraints
   *   - DDLOutput.junctionTables contains any junction tables
   */
  test("generates complete DDL output structure", () => {
    // Given: Enhanced JSON Schema with Organization and Team models
    const schema = {
      definitions: {
        Organization: {
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
        },
        Team: {
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
            organizationId: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization",
            },
            members: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User",
            },
          },
          required: ["name", "organizationId"],
        },
        User: {
          type: "object",
          properties: {
            id: {
              type: "string",
              format: "uuid",
              "x-mst-type": "identifier",
            },
            email: {
              type: "string",
            },
          },
          required: ["email"],
        },
      },
    }

    const dialect = createPostgresDialect()

    // When: generateDDL is called
    const result: DDLOutput = generateDDL(schema, dialect)

    // Then: Returns DDLOutput object
    expect(result).toBeDefined()
    expect(result.tables).toBeDefined()
    expect(result.foreignKeys).toBeDefined()
    expect(result.junctionTables).toBeDefined()
    expect(result.executionOrder).toBeDefined()

    // DDLOutput.tables contains TableDef for organization, team, and user (snake_case)
    expect(result.tables.length).toBe(3)
    const tableNames = result.tables.map((t) => t.name)
    expect(tableNames).toContain("organization")
    expect(tableNames).toContain("team")
    expect(tableNames).toContain("user")

    // DDLOutput.executionOrder is topologically sorted (snake_case table names)
    // organization has no dependencies, so it should come before team
    // user has no dependencies, so it should come before or at same level as team
    expect(result.executionOrder).toContain("organization")
    expect(result.executionOrder).toContain("team")
    expect(result.executionOrder).toContain("user")

    const orgIndex = result.executionOrder.indexOf("organization")
    const teamIndex = result.executionOrder.indexOf("team")
    expect(orgIndex).toBeLessThan(teamIndex) // organization must come before team

    // DDLOutput.foreignKeys contains FK constraints (snake_case table names)
    // team has FK to organization
    expect(result.foreignKeys.length).toBeGreaterThan(0)
    const teamOrgFk = result.foreignKeys.find(
      (fk) => fk.table === "team" && fk.referencesTable === "organization"
    )
    expect(teamOrgFk).toBeDefined()
    expect(teamOrgFk?.column).toBe("organization_id")
    expect(teamOrgFk?.referencesColumn).toBe("id")

    // DDLOutput.junctionTables contains team_members junction table (snake_case)
    expect(result.junctionTables.length).toBe(1)
    const teamMembersJunction = result.junctionTables.find(
      (t) => t.name === "team_members"
    )
    expect(teamMembersJunction).toBeDefined()
    expect(teamMembersJunction?.columns.length).toBe(2)
    expect(teamMembersJunction?.columns[0].name).toBe("team_id")
    expect(teamMembersJunction?.columns[1].name).toBe("user_id")

    // Junction table FKs should also be in foreignKeys array (snake_case)
    const teamMembersTeamFk = result.foreignKeys.find(
      (fk) =>
        fk.table === "team_members" && fk.referencesTable === "team"
    )
    const teamMembersUserFk = result.foreignKeys.find(
      (fk) =>
        fk.table === "team_members" && fk.referencesTable === "user"
    )
    expect(teamMembersTeamFk).toBeDefined()
    expect(teamMembersUserFk).toBeDefined()
  })
})
