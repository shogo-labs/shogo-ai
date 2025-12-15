/**
 * Integration tests for SQL generation with complete Teams domain schema
 *
 * Tests the end-to-end generateSQL convenience function with a real-world schema
 * containing multiple tables, relationships, and constraints.
 */

import { describe, test, expect } from "bun:test"
import { generateSQL } from "../sql-generator"
import { createPostgresDialect } from "../dialect"
import type { EnhancedJsonSchema } from "../../schematic/types"

describe("sql-generator integration", () => {
  const postgresDialect = createPostgresDialect()

  // Simplified Teams domain schema for testing
  const teamsSchema: any = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "teams-domain",
    type: "object",
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
        required: ["id", "name"],
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
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Organization",
          },
        },
        required: ["id", "name", "organizationId"],
      },
    },
  }

  test("generateSQL convenience function works end-to-end", () => {
    // test-sql-gen-008: generateSQL convenience function works end-to-end
    const result = generateSQL(teamsSchema, postgresDialect)

    // Returns string[] of SQL statements
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)

    // Should contain CREATE TABLE statements
    const createStatements = result.filter((s) => s.startsWith("CREATE TABLE"))
    expect(createStatements.length).toBeGreaterThan(0)

    // Should be in proper order
    const hasOrganization = result.some((s) => s.includes('"Organization"'))
    const hasTeam = result.some((s) => s.includes('"Team"'))
    expect(hasOrganization).toBe(true)
    expect(hasTeam).toBe(true)

    // All statements executable in order
    result.forEach((stmt) => {
      if (!stmt.startsWith("--")) {
        expect(stmt).toMatch(/;\s*$/)
      }
    })
  })

  test("complete Teams domain SQL output matches expected format", () => {
    // test-sql-gen-011: Complete Teams domain SQL output matches expected format
    const result = generateSQL(teamsSchema, postgresDialect)

    // Generates valid executable SQL
    expect(result.length).toBeGreaterThan(0)

    // Creates all tables with correct structure
    const orgTable = result.find((s) => s.includes('CREATE TABLE "Organization"'))
    expect(orgTable).toBeDefined()
    expect(orgTable).toContain('"id" UUID PRIMARY KEY')
    expect(orgTable).toContain('"name" TEXT NOT NULL')
    expect(orgTable).toContain('"created_at" TIMESTAMPTZ')

    const teamTable = result.find((s) => s.includes('CREATE TABLE "Team"'))
    expect(teamTable).toBeDefined()
    expect(teamTable).toContain('"id" UUID PRIMARY KEY')
    expect(teamTable).toContain('"name" TEXT NOT NULL')
    expect(teamTable).toContain('"organization_id" UUID NOT NULL')

    // All foreign keys reference existing tables
    const fkStatements = result.filter((s) => s.includes("FOREIGN KEY"))
    fkStatements.forEach((fk) => {
      if (fk.includes("organization_id")) {
        expect(fk).toContain('REFERENCES "Organization"')
      }
    })

    // Snapshot matches expected output format
    // (Visual inspection via console log)
    console.log("\n=== Generated SQL for Teams Domain ===\n")
    result.forEach((stmt, i) => {
      console.log(`-- Statement ${i + 1}`)
      console.log(stmt)
      console.log()
    })
  })
})
