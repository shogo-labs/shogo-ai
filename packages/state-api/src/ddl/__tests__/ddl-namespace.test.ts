/**
 * Integration tests for DDL generation with namespace isolation
 *
 * Tests the full pipeline of generating DDL statements with schema namespace
 * for both PostgreSQL and SQLite dialects.
 */

import { describe, test, expect } from "bun:test"
import { generateDDL, ddlOutputToSQL, createPostgresDialect, createSqliteDialect } from "../index"

const postgresDialect = createPostgresDialect()
const sqliteDialect = createSqliteDialect()

// Sample schema with FK relationships
const sampleSchema = {
  $defs: {
    Organization: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
        name: { type: "string" },
      },
      required: ["name"],
    },
    Team: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
        name: { type: "string" },
        organizationId: {
          type: "string",
          "x-reference-type": "single",
          "x-reference-target": "Organization",
        },
      },
      required: ["name", "organizationId"],
    },
  },
}

// Schema with junction table (many-to-many)
const schemaWithJunction = {
  $defs: {
    Team: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
        name: { type: "string" },
        members: {
          type: "array",
          items: { type: "string" },
          "x-reference-type": "array",
          "x-reference-target": "User",
        },
      },
      required: ["name"],
    },
    User: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
}

describe("DDL generation with namespace (PostgreSQL)", () => {
  test("generates CREATE SCHEMA IF NOT EXISTS statement", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, postgresDialect, { ifNotExists: true })

    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "inventory";')
  })

  test("generates qualified table names in CREATE TABLE", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    const createOrg = statements.find((s) => s.includes("organization"))
    expect(createOrg).toContain('CREATE TABLE "inventory"."organization"')
  })

  test("generates qualified table names in FK constraints", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    const alterTable = statements.find((s) => s.includes("ALTER TABLE"))
    expect(alterTable).toContain('ALTER TABLE "inventory"."team"')
    expect(alterTable).toContain('REFERENCES "inventory"."organization"')
  })

  test("includes namespace in FK constraint name", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    const alterTable = statements.find((s) => s.includes("ALTER TABLE"))
    expect(alterTable).toContain('"fk_inventory_team_organization_id"')
  })

  test("namespace is stored in DDLOutput", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    expect(ddl.namespace).toBe("inventory")
  })
})

describe("DDL generation with namespace (SQLite)", () => {
  test("does NOT generate CREATE SCHEMA for SQLite", () => {
    const ddl = generateDDL(sampleSchema, sqliteDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, sqliteDialect)

    expect(statements[0]).not.toContain("CREATE SCHEMA")
    expect(statements[0]).toContain("CREATE TABLE")
  })

  test("generates prefixed table names with double underscore", () => {
    const ddl = generateDDL(sampleSchema, sqliteDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, sqliteDialect)

    const createOrg = statements.find((s) => s.includes("organization"))
    expect(createOrg).toContain("inventory__organization")
  })

  test("generates prefixed table names in inline FK constraints", () => {
    const ddl = generateDDL(sampleSchema, sqliteDialect, { namespace: "inventory" })
    const statements = ddlOutputToSQL(ddl, sqliteDialect)

    const createTeam = statements.find((s) => s.includes("inventory__team"))
    expect(createTeam).toContain('REFERENCES "inventory__organization"')
  })
})

describe("DDL generation without namespace (backward compatibility)", () => {
  test("PostgreSQL: no CREATE SCHEMA when namespace is undefined", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect)
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    expect(statements[0]).not.toContain("CREATE SCHEMA")
    expect(statements[0]).toContain('CREATE TABLE "organization"')
  })

  test("SQLite: simple table names when namespace is undefined", () => {
    const ddl = generateDDL(sampleSchema, sqliteDialect)
    const statements = ddlOutputToSQL(ddl, sqliteDialect)

    expect(statements[0]).toContain('"organization"')
    expect(statements[0]).not.toContain("__")
  })

  test("DDLOutput.namespace is undefined when not provided", () => {
    const ddl = generateDDL(sampleSchema, postgresDialect)
    expect(ddl.namespace).toBeUndefined()
  })
})

describe("Junction tables with namespace", () => {
  test("PostgreSQL: junction table is fully qualified", () => {
    const ddl = generateDDL(schemaWithJunction, postgresDialect, { namespace: "hr" })
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    const junctionCreate = statements.find((s) => s.includes("team_members"))
    expect(junctionCreate).toContain('CREATE TABLE "hr"."team_members"')
  })

  test("PostgreSQL: junction FK references are qualified", () => {
    const ddl = generateDDL(schemaWithJunction, postgresDialect, { namespace: "hr" })
    const statements = ddlOutputToSQL(ddl, postgresDialect)

    const junctionFKs = statements.filter((s) => s.includes("fk_hr_team_members"))
    expect(junctionFKs.length).toBe(2)
    expect(junctionFKs[0]).toContain('REFERENCES "hr"."team"')
    expect(junctionFKs[1]).toContain('REFERENCES "hr"."user"')
  })

  test("SQLite: junction table is prefixed", () => {
    const ddl = generateDDL(schemaWithJunction, sqliteDialect, { namespace: "hr" })
    const statements = ddlOutputToSQL(ddl, sqliteDialect)

    const junctionCreate = statements.find((s) => s.includes("hr__team_members"))
    expect(junctionCreate).toBeDefined()
    expect(junctionCreate).toContain('REFERENCES "hr__team"')
    expect(junctionCreate).toContain('REFERENCES "hr__user"')
  })
})

describe("Namespace isolation prevents collisions", () => {
  test("two schemas with same model name produce different qualified names", () => {
    // Schema A in "inventory" namespace
    const ddlA = generateDDL(sampleSchema, postgresDialect, { namespace: "inventory" })
    const statementsA = ddlOutputToSQL(ddlA, postgresDialect)

    // Schema B in "hr" namespace
    const ddlB = generateDDL(sampleSchema, postgresDialect, { namespace: "hr" })
    const statementsB = ddlOutputToSQL(ddlB, postgresDialect)

    // Both have Organization model but in different namespaces
    const createOrgA = statementsA.find((s) => s.includes("organization"))
    const createOrgB = statementsB.find((s) => s.includes("organization"))

    expect(createOrgA).toContain('"inventory"."organization"')
    expect(createOrgB).toContain('"hr"."organization"')

    // They should be different
    expect(createOrgA).not.toEqual(createOrgB)
  })
})
