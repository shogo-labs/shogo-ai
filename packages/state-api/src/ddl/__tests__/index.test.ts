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

    // DDLOutput.tables contains TableDef for Organization, Team, and User
    expect(result.tables.length).toBe(3)
    const tableNames = result.tables.map((t) => t.name)
    expect(tableNames).toContain("Organization")
    expect(tableNames).toContain("Team")
    expect(tableNames).toContain("User")

    // DDLOutput.executionOrder is topologically sorted
    // Organization has no dependencies, so it should come before Team
    // User has no dependencies, so it should come before or at same level as Team
    expect(result.executionOrder).toContain("Organization")
    expect(result.executionOrder).toContain("Team")
    expect(result.executionOrder).toContain("User")

    const orgIndex = result.executionOrder.indexOf("Organization")
    const teamIndex = result.executionOrder.indexOf("Team")
    expect(orgIndex).toBeLessThan(teamIndex) // Organization must come before Team

    // DDLOutput.foreignKeys contains FK constraints
    // Team has FK to Organization
    expect(result.foreignKeys.length).toBeGreaterThan(0)
    const teamOrgFk = result.foreignKeys.find(
      (fk) => fk.table === "Team" && fk.referencesTable === "Organization"
    )
    expect(teamOrgFk).toBeDefined()
    expect(teamOrgFk?.column).toBe("organization_id")
    expect(teamOrgFk?.referencesColumn).toBe("id")

    // DDLOutput.junctionTables contains Team_members junction table
    expect(result.junctionTables.length).toBe(1)
    const teamMembersJunction = result.junctionTables.find(
      (t) => t.name === "Team_members"
    )
    expect(teamMembersJunction).toBeDefined()
    expect(teamMembersJunction?.columns.length).toBe(2)
    expect(teamMembersJunction?.columns[0].name).toBe("team_id")
    expect(teamMembersJunction?.columns[1].name).toBe("user_id")

    // Junction table FKs should also be in foreignKeys array
    const teamMembersTeamFk = result.foreignKeys.find(
      (fk) =>
        fk.table === "Team_members" && fk.referencesTable === "Team"
    )
    const teamMembersUserFk = result.foreignKeys.find(
      (fk) =>
        fk.table === "Team_members" && fk.referencesTable === "User"
    )
    expect(teamMembersTeamFk).toBeDefined()
    expect(teamMembersUserFk).toBeDefined()
  })
})
