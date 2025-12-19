/**
 * domain() SQL CRUD Tests with Column Mapping
 *
 * Verifies that reference properties are correctly mapped to FK columns
 * during SQL INSERT and normalized back to camelCase during SELECT.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import { createBackendRegistry } from "../../query/registry"
import { SqlBackend } from "../../query/backends/sql"
import { NullPersistence } from "../../persistence/null"
import { teamsDomain } from "../../teams/domain"
import { generateDDL, createSqliteDialect, tableDefToCreateTableSQL } from "../../ddl"

const sqliteDialect = createSqliteDialect()

function createTablesFromSchema(db: Database) {
  const ddl = generateDDL(teamsDomain.enhancedSchema, sqliteDialect)
  for (const tableName of ddl.executionOrder) {
    const table = ddl.tables.find((t) => t.name === tableName)
    if (table) {
      db.run(tableDefToCreateTableSQL(table, sqliteDialect))
    }
  }
}

function createSqlEnvironment(db: Database) {
  const registry = createBackendRegistry()
  const executor = new BunSqlExecutor(db)
  const sqlBackend = new SqlBackend({ dialect: "sqlite", executor })
  registry.register("sql", sqlBackend)
  registry.setDefault("sql")

  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "teams-workspace",
    },
  }
}

describe("domain() SQL CRUD with Column Mapping", () => {
  let store: any
  let db: Database
  let orgId: string
  let teamId: string

  beforeEach(() => {
    // NO metaStore setup - createStore() should work directly with SQL backend
    // Column mapping comes from pre-computed maps passed through env.context
    db = new Database(":memory:")
    createTablesFromSchema(db)

    const env = createSqlEnvironment(db)
    store = teamsDomain.createStore(env)

    orgId = crypto.randomUUID()
    teamId = crypto.randomUUID()
  })

  afterEach(() => {
    db.close()
  })

  describe("INSERT maps camelCase to snake_case FK columns", () => {
    test("Team.organizationId -> organization_id column", async () => {
      // Insert organization first
      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme",
        slug: "acme",
        createdAt: Date.now(),
      })

      // Insert team with organizationId (camelCase property)
      await store.teamCollection.insertOne({
        id: teamId,
        name: "Engineering",
        organizationId: orgId, // camelCase
        createdAt: Date.now(),
      })

      // Verify SQL table has snake_case column
      const result = db.prepare("SELECT organization_id FROM team WHERE id = ?").get(teamId) as any
      expect(result.organization_id).toBe(orgId)
    })

    test("Membership with optional references", async () => {
      const memId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme",
        slug: "acme",
        createdAt: Date.now(),
      })

      await store.teamCollection.insertOne({
        id: teamId,
        name: "Engineering",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Insert membership with both optional refs
      await store.membershipCollection.insertOne({
        id: memId,
        userId: "user-alice",
        role: "admin",
        organizationId: orgId, // optional ref
        teamId: teamId, // optional ref
        createdAt: Date.now(),
      })

      // Verify both FK columns
      const result = db.prepare("SELECT organization_id, team_id FROM membership WHERE id = ?").get(memId) as any
      expect(result.organization_id).toBe(orgId)
      expect(result.team_id).toBe(teamId)
    })
  })

  describe("SELECT normalizes snake_case to camelCase", () => {
    test("Team query returns organizationId not organization_id", async () => {
      // Seed via raw SQL with snake_case
      db.run("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)", [
        orgId,
        "Acme",
        "acme",
        Date.now(),
      ])
      db.run("INSERT INTO team (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)", [
        teamId,
        "Engineering",
        orgId,
        Date.now(),
      ])

      // Query via store should return camelCase
      const team = await store.teamCollection.query().where({ id: teamId }).first()

      expect(team.organizationId).toBe(orgId) // camelCase
      expect((team as any).organization_id).toBeUndefined() // NOT snake_case
    })

    test("Membership query returns teamId and organizationId", async () => {
      const memId = crypto.randomUUID()

      db.run("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)", [
        orgId,
        "Acme",
        "acme",
        Date.now(),
      ])
      db.run("INSERT INTO team (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)", [
        teamId,
        "Engineering",
        orgId,
        Date.now(),
      ])
      db.run(
        "INSERT INTO membership (id, user_id, role, organization_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [memId, "user-alice", "admin", orgId, teamId, Date.now()]
      )

      const mem = await store.membershipCollection.query().where({ id: memId }).first()

      expect(mem.organizationId).toBe(orgId)
      expect(mem.teamId).toBe(teamId)
      expect((mem as any).organization_id).toBeUndefined()
      expect((mem as any).team_id).toBeUndefined()
    })
  })

  describe("Self-reference works in SQL round-trip", () => {
    test("Team.parentId -> team_id column and back", async () => {
      const parentTeamId = crypto.randomUUID()
      const childTeamId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme",
        slug: "acme",
        createdAt: Date.now(),
      })

      // Parent team
      await store.teamCollection.insertOne({
        id: parentTeamId,
        name: "Engineering",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Child team with parentId (self-reference)
      await store.teamCollection.insertOne({
        id: childTeamId,
        name: "Frontend",
        organizationId: orgId,
        parentId: parentTeamId, // self-reference
        createdAt: Date.now(),
      })

      // Verify SQL has team_id column
      const sqlResult = db.prepare("SELECT team_id FROM team WHERE id = ?").get(childTeamId) as any
      expect(sqlResult.team_id).toBe(parentTeamId)

      // Query returns parentId (camelCase)
      const child = await store.teamCollection.query().where({ id: childTeamId }).first()
      expect(child.parentId).toBe(parentTeamId)
      expect((child as any).team_id).toBeUndefined()
    })
  })

  describe("Filter by reference property", () => {
    test("where({ organizationId }) filters correctly", async () => {
      const org2Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme",
        slug: "acme",
        createdAt: Date.now(),
      })
      await store.organizationCollection.insertOne({
        id: org2Id,
        name: "Other",
        slug: "other",
        createdAt: Date.now(),
      })

      await store.teamCollection.insertOne({
        id: teamId,
        name: "Acme Team",
        organizationId: orgId,
        createdAt: Date.now(),
      })
      await store.teamCollection.insertOne({
        id: crypto.randomUUID(),
        name: "Other Team",
        organizationId: org2Id,
        createdAt: Date.now(),
      })

      // Filter by organizationId (camelCase)
      const acmeTeams = await store.teamCollection.query().where({ organizationId: orgId }).toArray()

      expect(acmeTeams).toHaveLength(1)
      expect(acmeTeams[0].name).toBe("Acme Team")
    })
  })
})
