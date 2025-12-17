/**
 * Teams DDL Integration Test
 *
 * Validates that the teams domain schema flows correctly through to DDL generation.
 * This test verifies:
 * 1. teamsDomain.enhancedSchema has x-mst-type: "identifier" on id properties
 * 2. DDL generator can process the teams schema without manual metadata
 * 3. Generated DDL creates valid tables with proper primary keys
 */

import { describe, test, expect } from "bun:test"
import { teamsDomain } from "../../teams/domain"
import { generateDDL, createSqliteDialect } from "../index"

const sqliteDialect = createSqliteDialect()

describe("Teams Domain DDL Integration", () => {

  describe("Enhanced Schema Metadata Validation", () => {

    test("teamsDomain.enhancedSchema has $defs with model definitions", () => {
      const schema = teamsDomain.enhancedSchema

      expect(schema.$defs).toBeDefined()
      expect(schema.$defs?.Organization).toBeDefined()
      expect(schema.$defs?.Team).toBeDefined()
      expect(schema.$defs?.Membership).toBeDefined()
    })

    test("Organization.id has x-mst-type: 'identifier'", () => {
      const schema = teamsDomain.enhancedSchema
      const orgDef = schema.$defs?.Organization as any

      expect(orgDef?.properties?.id).toBeDefined()
      expect(orgDef?.properties?.id["x-mst-type"]).toBe("identifier")
    })

    test("Team.id has x-mst-type: 'identifier'", () => {
      const schema = teamsDomain.enhancedSchema
      const teamDef = schema.$defs?.Team as any

      expect(teamDef?.properties?.id).toBeDefined()
      expect(teamDef?.properties?.id["x-mst-type"]).toBe("identifier")
    })

    test("Membership.id has x-mst-type: 'identifier'", () => {
      const schema = teamsDomain.enhancedSchema
      const membershipDef = schema.$defs?.Membership as any

      expect(membershipDef?.properties?.id).toBeDefined()
      expect(membershipDef?.properties?.id["x-mst-type"]).toBe("identifier")
    })

    test("App.id has x-mst-type: 'identifier'", () => {
      const schema = teamsDomain.enhancedSchema
      const appDef = schema.$defs?.App as any

      expect(appDef?.properties?.id).toBeDefined()
      expect(appDef?.properties?.id["x-mst-type"]).toBe("identifier")
    })

    test("Invitation.id has x-mst-type: 'identifier'", () => {
      const schema = teamsDomain.enhancedSchema
      const invitationDef = schema.$defs?.Invitation as any

      expect(invitationDef?.properties?.id).toBeDefined()
      expect(invitationDef?.properties?.id["x-mst-type"]).toBe("identifier")
    })
  })

  describe("DDL Generation from Teams Schema", () => {

    test("generateDDL accepts teamsDomain.enhancedSchema without error", () => {
      const schema = teamsDomain.enhancedSchema

      // This should NOT throw - if it does, the schema lacks required metadata
      expect(() => generateDDL(schema, sqliteDialect)).not.toThrow()
    })

    test("generated DDL includes all entity tables", () => {
      const schema = teamsDomain.enhancedSchema
      const ddl = generateDDL(schema, sqliteDialect)

      const tableNames = ddl.tables.map(t => t.name)

      expect(tableNames).toContain("Organization")
      expect(tableNames).toContain("Team")
      expect(tableNames).toContain("Membership")
      expect(tableNames).toContain("App")
      expect(tableNames).toContain("Invitation")
    })

    test("Organization table has id as primary key", () => {
      const schema = teamsDomain.enhancedSchema
      const ddl = generateDDL(schema, sqliteDialect)

      const orgTable = ddl.tables.find(t => t.name === "Organization")
      expect(orgTable).toBeDefined()
      expect(orgTable?.primaryKey).toBe("id")
    })

    test("Team table has id as primary key", () => {
      const schema = teamsDomain.enhancedSchema
      const ddl = generateDDL(schema, sqliteDialect)

      const teamTable = ddl.tables.find(t => t.name === "Team")
      expect(teamTable).toBeDefined()
      expect(teamTable?.primaryKey).toBe("id")
    })

    test("executionOrder is topologically sorted by FK dependencies", () => {
      const schema = teamsDomain.enhancedSchema
      const ddl = generateDDL(schema, sqliteDialect)

      // Organization should come before Team (Team references Organization)
      const orgIndex = ddl.executionOrder.indexOf("Organization")
      const teamIndex = ddl.executionOrder.indexOf("Team")

      expect(orgIndex).toBeLessThan(teamIndex)
    })
  })
})
