/**
 * domain() -> DDL Integration Tests
 *
 * Verifies that ArkType domains with entity references generate correct
 * FK column names in DDL output.
 */

import { describe, test, expect } from "bun:test"
import { teamsDomain, TeamsDomain } from "../../teams/domain"
import { generateDDL, createPostgresDialect, createSqliteDialect } from "../../ddl"
import { domain } from "../domain"
import { scope } from "arktype"

describe("domain() -> DDL Integration", () => {
  describe("TeamsDomain FK column generation", () => {
    test("Team table has organization_id FK column", () => {
      const ddl = generateDDL(teamsDomain.enhancedSchema, createPostgresDialect())

      const teamTable = ddl.tables.find((t) => t.name === "team")
      expect(teamTable).toBeDefined()

      // organizationId property -> organization_id column
      const orgColumn = teamTable!.columns.find((c) => c.name === "organization_id")
      expect(orgColumn).toBeDefined()
      expect(orgColumn!.type).toBe("UUID")
      expect(orgColumn!.nullable).toBe(false) // required reference

      // FK constraint exists
      const orgFk = teamTable!.foreignKeys.find((fk) => fk.column === "organization_id")
      expect(orgFk).toBeDefined()
      expect(orgFk!.referencesTable).toBe("organization")
    })

    test("Self-reference generates FK to same table", () => {
      const ddl = generateDDL(teamsDomain.enhancedSchema, createPostgresDialect())

      const teamTable = ddl.tables.find((t) => t.name === "team")
      expect(teamTable).toBeDefined()

      // parentId property -> team_id column (self-reference)
      const parentColumn = teamTable!.columns.find((c) => c.name === "team_id")
      expect(parentColumn).toBeDefined()
      expect(parentColumn!.nullable).toBe(true) // optional reference

      // FK references same table
      const parentFk = teamTable!.foreignKeys.find((fk) => fk.column === "team_id")
      expect(parentFk).toBeDefined()
      expect(parentFk!.referencesTable).toBe("team")
    })

    test("Membership table has team_id and organization_id FK columns", () => {
      const ddl = generateDDL(teamsDomain.enhancedSchema, createPostgresDialect())

      const membershipTable = ddl.tables.find((t) => t.name === "membership")
      expect(membershipTable).toBeDefined()

      // teamId -> team_id
      const teamColumn = membershipTable!.columns.find((c) => c.name === "team_id")
      expect(teamColumn).toBeDefined()
      expect(teamColumn!.nullable).toBe(true) // optional

      // organizationId -> organization_id
      const orgColumn = membershipTable!.columns.find((c) => c.name === "organization_id")
      expect(orgColumn).toBeDefined()
      expect(orgColumn!.nullable).toBe(true) // optional
    })

    test("App table has team_id FK column", () => {
      const ddl = generateDDL(teamsDomain.enhancedSchema, createPostgresDialect())

      const appTable = ddl.tables.find((t) => t.name === "app")
      expect(appTable).toBeDefined()

      const teamColumn = appTable!.columns.find((c) => c.name === "team_id")
      expect(teamColumn).toBeDefined()
      expect(teamColumn!.nullable).toBe(false) // required
    })
  })

  describe("x-reference-target in Enhanced JSON Schema", () => {
    test("ArkType references produce x-reference-target", () => {
      const schema = teamsDomain.enhancedSchema

      // Team.organizationId -> x-reference-target: "Organization"
      const teamOrgProp = schema.$defs!.Team.properties.organizationId
      expect(teamOrgProp["x-reference-target"]).toBe("Organization")
      expect(teamOrgProp["x-reference-type"]).toBe("single")

      // Team.parentId -> x-reference-target: "Team"
      const teamParentProp = schema.$defs!.Team.properties.parentId
      expect(teamParentProp["x-reference-target"]).toBe("Team")

      // App.teamId -> x-reference-target: "Team"
      const appTeamProp = schema.$defs!.App.properties.teamId
      expect(appTeamProp["x-reference-target"]).toBe("Team")
    })
  })

  describe("Custom domain FK generation", () => {
    test("Simple two-entity domain generates correct FK", () => {
      const MyDomain = scope({
        Company: { id: "string.uuid", name: "string" },
        Employee: { id: "string.uuid", name: "string", company: "Company" },
      })

      const myDomain = domain({ name: "test-domain", from: MyDomain })
      const ddl = generateDDL(myDomain.enhancedSchema, createPostgresDialect())

      const employeeTable = ddl.tables.find((t) => t.name === "employee")
      expect(employeeTable).toBeDefined()

      // company property -> company_id column
      const companyColumn = employeeTable!.columns.find((c) => c.name === "company_id")
      expect(companyColumn).toBeDefined()

      const companyFk = employeeTable!.foreignKeys.find((fk) => fk.column === "company_id")
      expect(companyFk).toBeDefined()
      expect(companyFk!.referencesTable).toBe("company")
    })
  })
})
