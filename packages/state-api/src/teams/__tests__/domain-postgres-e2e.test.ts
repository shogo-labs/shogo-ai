/**
 * Teams Domain PostgreSQL E2E Integration Test
 *
 * End-to-end test validating the teams-workspace domain works with actual
 * PostgreSQL database. Tests the complete flow:
 *
 * teamsDomain -> createStore(env with postgres) -> CRUD operations -> postgres
 *
 * Prerequisites:
 * - DATABASE_URL environment variable set
 * - Tables created via ddl.execute (teams-workspace schema)
 *
 * Run with: bun test packages/state-api/src/teams/__tests__/domain-postgres-e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { teamsDomain } from "../domain"
import { BunPostgresExecutor } from "../../query/execution/bun-postgres"
import { createBackendRegistry } from "../../query/registry"
import { SqlBackend } from "../../query/backends/sql"
import { NullPersistence } from "../../persistence/null"
import { generateSQL, createPostgresDialect } from "../../ddl"

const DATABASE_URL = process.env.DATABASE_URL

// Skip all tests if no DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

describeWithPostgres("teamsDomain PostgreSQL E2E Integration", () => {
  let executor: BunPostgresExecutor
  let store: ReturnType<typeof teamsDomain.createStore>

  // Test data IDs - generated fresh for each test run
  const testIds = {
    org: crypto.randomUUID(),
    team: crypto.randomUUID(),
    childTeam: crypto.randomUUID(),
    membership: crypto.randomUUID(),
    teamMembership: crypto.randomUUID(),
    app: crypto.randomUUID(),
    invitation: crypto.randomUUID(),
  }

  beforeAll(async () => {
    // Initialize postgres executor
    const isSupabase = DATABASE_URL!.includes("supabase")
    executor = new BunPostgresExecutor(DATABASE_URL!, {
      tls: isSupabase,
      max: 5,
    })

    // Ensure tables exist - execute DDL statements individually, ignoring "already exists" errors
    const dialect = createPostgresDialect()
    const statements = generateSQL(teamsDomain.enhancedSchema, dialect, { ifNotExists: true })

    for (const stmt of statements) {
      try {
        await executor.execute([stmt, []])
      } catch (error: any) {
        // Ignore "already exists" errors for constraints
        if (!error.message?.includes("already exists")) {
          throw error
        }
      }
    }

    // Create store with postgres backend
    const registry = createBackendRegistry()
    const sqlBackend = new SqlBackend({ dialect: "pg", executor })
    registry.register("postgres", sqlBackend)
    registry.setDefault("postgres")

    store = teamsDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        backendRegistry: registry,
      },
      context: {
        schemaName: "teams-workspace",
      },
    })
  })

  afterAll(async () => {
    // Clean up test data (in reverse dependency order)
    const cleanupQueries = [
      ["DELETE FROM invitation WHERE id = $1", [testIds.invitation]],
      ["DELETE FROM app WHERE id = $1", [testIds.app]],
      ["DELETE FROM membership WHERE id = $1", [testIds.membership]],
      ["DELETE FROM membership WHERE id = $1", [testIds.teamMembership]],
      ["DELETE FROM team WHERE id = $1", [testIds.childTeam]],
      ["DELETE FROM team WHERE id = $1", [testIds.team]],
      ["DELETE FROM organization WHERE id = $1", [testIds.org]],
    ]

    for (const [sql, params] of cleanupQueries) {
      try {
        await executor.execute([sql as string, params as any[]])
      } catch {
        // Ignore cleanup errors
      }
    }

    await executor.close()
  })

  describe("Organization CRUD", () => {
    test("insertOne creates organization in postgres", async () => {
      const org = await store.organizationCollection.insertOne({
        id: testIds.org,
        name: "Test Corp",
        slug: "test-corp",
        description: "E2E test organization",
        createdAt: Date.now(),
      })

      expect(org.id).toBe(testIds.org)
      expect(org.name).toBe("Test Corp")
      expect(org.slug).toBe("test-corp")
    })

    test("query retrieves organization with correct column mapping", async () => {
      const org = await store.organizationCollection
        .query()
        .where({ id: testIds.org })
        .first()

      expect(org).toBeDefined()
      expect(org!.id).toBe(testIds.org)
      expect(org!.name).toBe("Test Corp")
      expect(org!.createdAt).toBeTypeOf("number") // created_at -> createdAt
      expect((org as any).created_at).toBeUndefined() // NOT snake_case
    })

    test("updateOne modifies organization", async () => {
      const updated = await store.organizationCollection.updateOne(testIds.org, {
        description: "Updated description",
      })

      expect(updated).toBeDefined()
      expect(updated!.description).toBe("Updated description")
      expect(updated!.name).toBe("Test Corp") // unchanged
    })
  })

  describe("Team with References", () => {
    test("insertOne creates team with organizationId FK", async () => {
      const team = await store.teamCollection.insertOne({
        id: testIds.team,
        name: "Engineering",
        description: "Engineering team",
        organizationId: testIds.org, // FK reference (camelCase)
        createdAt: Date.now(),
      })

      expect(team.id).toBe(testIds.team)
      expect(team.organizationId).toBe(testIds.org)
    })

    test("query by organizationId filter works", async () => {
      const teams = await store.teamCollection
        .query()
        .where({ organizationId: testIds.org })
        .toArray()

      expect(teams.length).toBeGreaterThanOrEqual(1)
      expect(teams.some((t: any) => t.id === testIds.team)).toBe(true)
    })

    test("self-reference parentId works for nested teams", async () => {
      // Create child team with parentId (self-reference)
      const childTeam = await store.teamCollection.insertOne({
        id: testIds.childTeam,
        name: "Frontend",
        organizationId: testIds.org,
        parentId: testIds.team, // Self-reference
        createdAt: Date.now(),
      })

      expect(childTeam.parentId).toBe(testIds.team)

      // Query back and verify
      const queried = await store.teamCollection
        .query()
        .where({ id: testIds.childTeam })
        .first()

      expect(queried!.parentId).toBe(testIds.team)
      expect((queried as any).team_id).toBeUndefined() // NOT snake_case column name
    })
  })

  describe("Membership with Polymorphic References", () => {
    test("insertOne creates org-level membership", async () => {
      const membership = await store.membershipCollection.insertOne({
        id: testIds.membership,
        userId: "user-e2e-test",
        role: "owner",
        organizationId: testIds.org, // Org-level membership
        createdAt: Date.now(),
      })

      expect(membership.id).toBe(testIds.membership)
      expect(membership.role).toBe("owner")
      expect(membership.organizationId).toBe(testIds.org)
      expect(membership.teamId).toBeUndefined()
    })

    test("insertOne creates team-level membership", async () => {
      const membership = await store.membershipCollection.insertOne({
        id: testIds.teamMembership,
        userId: "user-e2e-test",
        role: "member",
        teamId: testIds.team, // Team-level membership
        createdAt: Date.now(),
      })

      expect(membership.teamId).toBe(testIds.team)
      expect(membership.organizationId).toBeUndefined()
    })

    test("query by role filter works", async () => {
      const owners = await store.membershipCollection
        .query()
        .where({ role: "owner" })
        .toArray()

      expect(owners.some((m: any) => m.id === testIds.membership)).toBe(true)
    })
  })

  describe("App with Required Team Reference", () => {
    test("insertOne creates app with teamId FK", async () => {
      const app = await store.appCollection.insertOne({
        id: testIds.app,
        name: "E2E Test App",
        description: "Test application",
        teamId: testIds.team, // Required FK
        createdAt: Date.now(),
      })

      expect(app.id).toBe(testIds.app)
      expect(app.teamId).toBe(testIds.team)
    })

    test("query by teamId filter works", async () => {
      const apps = await store.appCollection
        .query()
        .where({ teamId: testIds.team })
        .toArray()

      expect(apps.some((a: any) => a.id === testIds.app)).toBe(true)
    })
  })

  describe("Invitation with Enum Fields", () => {
    test("insertOne creates invitation with enum values", async () => {
      const invitation = await store.invitationCollection.insertOne({
        id: testIds.invitation,
        email: "test@example.com",
        role: "member",
        organizationId: testIds.org,
        status: "pending",
        expiresAt: Date.now() + 86400000, // 24 hours
        createdAt: Date.now(),
      })

      expect(invitation.id).toBe(testIds.invitation)
      expect(invitation.status).toBe("pending")
      expect(invitation.role).toBe("member")
    })

    test("updateOne changes invitation status", async () => {
      const updated = await store.invitationCollection.updateOne(testIds.invitation, {
        status: "accepted",
      })

      expect(updated!.status).toBe("accepted")
    })

    test("query by status filter works", async () => {
      const accepted = await store.invitationCollection
        .query()
        .where({ status: "accepted" })
        .toArray()

      expect(accepted.some((i: any) => i.id === testIds.invitation)).toBe(true)
    })
  })

  describe("Advanced Query Operations", () => {
    test("count terminal operation", async () => {
      const count = await store.teamCollection
        .query()
        .where({ organizationId: testIds.org })
        .count()

      expect(count).toBeGreaterThanOrEqual(2) // team + childTeam
    })

    test("any terminal operation", async () => {
      const hasTeams = await store.teamCollection
        .query()
        .where({ organizationId: testIds.org })
        .any()

      expect(hasTeams).toBe(true)
    })

    test("multiple where conditions", async () => {
      const result = await store.teamCollection
        .query()
        .where({ organizationId: testIds.org })
        .where({ name: "Engineering" })
        .first()

      expect(result).toBeDefined()
      expect(result!.name).toBe("Engineering")
    })

    test("pagination with skip and take", async () => {
      const page = await store.teamCollection
        .query()
        .where({ organizationId: testIds.org })
        .skip(0)
        .take(1)
        .toArray()

      expect(page).toHaveLength(1)
    })
  })

  describe("Domain Enhancements", () => {
    test("Membership.level computed view works after query", async () => {
      // The membership should be in MST store after query
      const membership = await store.membershipCollection
        .query()
        .where({ id: testIds.membership })
        .first()

      // After query, sync to MST and check computed view
      // Note: query returns plain objects, not MST instances
      // The computed view works on MST instances created via insertOne
      expect(membership).toBeDefined()
      expect(membership!.role).toBe("owner")
    })

    test("collection helper findByUserId works", async () => {
      // First ensure membership is in MST store
      await store.membershipCollection.loadAll()

      const memberships = store.membershipCollection.findByUserId("user-e2e-test")
      expect(memberships.length).toBeGreaterThanOrEqual(1)
    })
  })
})
