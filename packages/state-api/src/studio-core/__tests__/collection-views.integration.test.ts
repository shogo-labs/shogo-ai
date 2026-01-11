/**
 * TDD Integration Tests for task-member-collection-views
 * Task: Add collection query views to InvitationCollection
 * Feature: member-management-invitation
 *
 * Test Specifications:
 * - test-collection-views-001: InvitationCollection.findForResource returns invitations for organization
 * - test-collection-views-002: InvitationCollection.findForResource returns invitations for team
 * - test-collection-views-003: InvitationCollection.findForResource returns invitations for project
 * - test-collection-views-004: InvitationCollection.findByEmail returns all invitations for email
 * - test-collection-views-005: InvitationCollection.findByEmail returns empty array for no matches
 * - test-collection-views-006: Existing findPending collection view still works
 * - test-collection-views-007: Existing MemberCollection.findByUserId still works
 * - test-collection-views-008: Existing MemberCollection.findForResource still works
 *
 * CRITICAL: These are integration tests using REAL PostgreSQL - NO MOCKS
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { studioCoreDomain } from "../domain"
import { BunPostgresExecutor } from "../../query/execution/bun-postgres"
import { createBackendRegistry } from "../../query/registry"
import { SqlBackend } from "../../query/backends/sql"
import { NullPersistence } from "../../persistence/null"
import { generateSQL, createPostgresDialect } from "../../ddl"

const DATABASE_URL = process.env.DATABASE_URL

// Skip all tests if no DATABASE_URL
const describeWithPostgres = DATABASE_URL ? describe : describe.skip

describeWithPostgres("Collection Views - PostgreSQL Integration", () => {
  let executor: BunPostgresExecutor
  let store: ReturnType<typeof studioCoreDomain.createStore>

  const testRunId = crypto.randomUUID().slice(0, 8)

  beforeAll(async () => {
    const isSupabase = DATABASE_URL!.includes("supabase")
    executor = new BunPostgresExecutor(DATABASE_URL!, {
      tls: isSupabase,
      max: 5,
    })

    // Ensure tables exist
    const dialect = createPostgresDialect()
    const statements = generateSQL(studioCoreDomain.enhancedSchema, dialect, { ifNotExists: true })

    for (const stmt of statements) {
      try {
        await executor.execute([stmt, []])
      } catch (error: any) {
        if (!error.message?.includes("already exists")) {
          throw error
        }
      }
    }
  })

  afterAll(async () => {
    await executor.close()
  })

  beforeEach(async () => {
    const registry = createBackendRegistry()
    const sqlBackend = new SqlBackend({ dialect: "pg", executor })
    registry.register("postgres", sqlBackend)
    registry.setDefault("postgres")

    store = studioCoreDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        backendRegistry: registry,
      },
      context: {
        schemaName: "studio-core",
      },
    })
  })

  // ============================================================
  // test-collection-views-001: findForResource returns invitations for organization
  // ============================================================
  describe("test-collection-views-001: findForResource for organization", () => {
    let org1Id: string
    let org2Id: string
    let inv1Id: string
    let inv2Id: string
    let inv3Id: string
    let inv4Id: string

    beforeEach(async () => {
      org1Id = crypto.randomUUID()
      org2Id = crypto.randomUUID()
      inv1Id = crypto.randomUUID()
      inv2Id = crypto.randomUUID()
      inv3Id = crypto.randomUUID()
      inv4Id = crypto.randomUUID()

      // Create orgs
      await store.organizationCollection.insertOne({
        id: org1Id,
        name: `Org 1 ${testRunId}`,
        slug: `org-1-${testRunId}`,
        createdAt: Date.now(),
      })

      await store.organizationCollection.insertOne({
        id: org2Id,
        name: `Org 2 ${testRunId}`,
        slug: `org-2-${testRunId}`,
        createdAt: Date.now(),
      })

      // 3 invitations for org1
      await store.invitationCollection.insertOne({
        id: inv1Id,
        email: "user1@example.com",
        role: "member",
        organizationId: org1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv2Id,
        email: "user2@example.com",
        role: "admin",
        organizationId: org1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv3Id,
        email: "user3@example.com",
        role: "viewer",
        organizationId: org1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      // 1 invitation for org2
      await store.invitationCollection.insertOne({
        id: inv4Id,
        email: "user4@example.com",
        role: "member",
        organizationId: org2Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv1Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv2Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv3Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv4Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org1Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org2Id]])
    })

    test("Returns 3 invitations for org1, not org2's invitation", async () => {
      // Load data into MST store
      await store.invitationCollection.loadAll()

      const org1Invitations = store.invitationCollection.findForResource("organization", org1Id)

      expect(org1Invitations).toHaveLength(3)
      expect(org1Invitations.every((i: any) => i.organization?.id === org1Id)).toBe(true)
      expect(org1Invitations.some((i: any) => i.id === inv4Id)).toBe(false)
    })
  })

  // ============================================================
  // test-collection-views-002: findForResource returns invitations for team
  // ============================================================
  describe("test-collection-views-002: findForResource for team", () => {
    let orgId: string
    let team1Id: string
    let team2Id: string
    let inv1Id: string
    let inv2Id: string
    let inv3Id: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      team1Id = crypto.randomUUID()
      team2Id = crypto.randomUUID()
      inv1Id = crypto.randomUUID()
      inv2Id = crypto.randomUUID()
      inv3Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Org ${testRunId}`,
        slug: `org-${testRunId}-002`,
        createdAt: Date.now(),
      })

      await store.teamCollection.insertOne({
        id: team1Id,
        name: "Team 1",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      await store.teamCollection.insertOne({
        id: team2Id,
        name: "Team 2",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // 2 invitations for team1
      await store.invitationCollection.insertOne({
        id: inv1Id,
        email: "teamuser1@example.com",
        role: "member",
        teamId: team1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv2Id,
        email: "teamuser2@example.com",
        role: "admin",
        teamId: team1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      // 1 invitation for team2
      await store.invitationCollection.insertOne({
        id: inv3Id,
        email: "teamuser3@example.com",
        role: "member",
        teamId: team2Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv1Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv2Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv3Id]])
      await executor.execute(["DELETE FROM studio_core__team WHERE id = $1", [team1Id]])
      await executor.execute(["DELETE FROM studio_core__team WHERE id = $1", [team2Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Returns 2 invitations for team1, not team2 or org-level", async () => {
      await store.invitationCollection.loadAll()

      const team1Invitations = store.invitationCollection.findForResource("team", team1Id)

      expect(team1Invitations).toHaveLength(2)
      expect(team1Invitations.every((i: any) => i.team?.id === team1Id)).toBe(true)
    })
  })

  // ============================================================
  // test-collection-views-003: findForResource returns invitations for project
  // ============================================================
  describe("test-collection-views-003: findForResource for project", () => {
    let orgId: string
    let projectId: string
    let inv1Id: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      projectId = crypto.randomUUID()
      inv1Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Org ${testRunId}`,
        slug: `org-${testRunId}-003`,
        createdAt: Date.now(),
      })

      await store.projectCollection.insertOne({
        id: projectId,
        name: "Project 1",
        organizationId: orgId,
        tier: "starter",
        status: "active",
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv1Id,
        email: "projectuser@example.com",
        role: "member",
        projectId: projectId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv1Id]])
      await executor.execute(["DELETE FROM studio_core__project WHERE id = $1", [projectId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Returns invitations for project, not org/team level", async () => {
      await store.invitationCollection.loadAll()

      const projectInvitations = store.invitationCollection.findForResource("project", projectId)

      expect(projectInvitations.length).toBeGreaterThanOrEqual(1)
      expect(projectInvitations[0].project?.id).toBe(projectId)
    })
  })

  // ============================================================
  // test-collection-views-004: findByEmail returns all invitations for email
  // ============================================================
  describe("test-collection-views-004: findByEmail returns invitations for email", () => {
    let org1Id: string
    let org2Id: string
    let inv1Id: string
    let inv2Id: string
    let inv3Id: string

    beforeEach(async () => {
      org1Id = crypto.randomUUID()
      org2Id = crypto.randomUUID()
      inv1Id = crypto.randomUUID()
      inv2Id = crypto.randomUUID()
      inv3Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: org1Id,
        name: `Org 1 ${testRunId}`,
        slug: `org-1-${testRunId}-004`,
        createdAt: Date.now(),
      })

      await store.organizationCollection.insertOne({
        id: org2Id,
        name: `Org 2 ${testRunId}`,
        slug: `org-2-${testRunId}-004`,
        createdAt: Date.now(),
      })

      // 2 invitations for alice@example.com across different orgs
      await store.invitationCollection.insertOne({
        id: inv1Id,
        email: "alice@example.com",
        role: "member",
        organizationId: org1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv2Id,
        email: "alice@example.com",
        role: "admin",
        organizationId: org2Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      // 1 invitation for bob@example.com
      await store.invitationCollection.insertOne({
        id: inv3Id,
        email: "bob@example.com",
        role: "member",
        organizationId: org1Id,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv1Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv2Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv3Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org1Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org2Id]])
    })

    test("Returns 2 invitations for alice, not bob's invitation", async () => {
      await store.invitationCollection.loadAll()

      const aliceInvitations = store.invitationCollection.findByEmail("alice@example.com")

      expect(aliceInvitations).toHaveLength(2)
      expect(aliceInvitations.every((i: any) => i.email === "alice@example.com")).toBe(true)
      expect(aliceInvitations.some((i: any) => i.email === "bob@example.com")).toBe(false)
    })
  })

  // ============================================================
  // test-collection-views-005: findByEmail returns empty array for no matches
  // ============================================================
  describe("test-collection-views-005: findByEmail returns empty for no matches", () => {
    let orgId: string
    let invId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      invId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Org ${testRunId}`,
        slug: `org-${testRunId}-005`,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: invId,
        email: "exists@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [invId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Returns empty array for nonexistent email", async () => {
      await store.invitationCollection.loadAll()

      const noInvitations = store.invitationCollection.findByEmail("nonexistent@example.com")

      expect(noInvitations).toHaveLength(0)
      expect(Array.isArray(noInvitations)).toBe(true)
    })
  })

  // ============================================================
  // test-collection-views-006: Existing findPending still works
  // ============================================================
  describe("test-collection-views-006: findPending still works", () => {
    let orgId: string
    let inv1Id: string
    let inv2Id: string
    let inv3Id: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      inv1Id = crypto.randomUUID()
      inv2Id = crypto.randomUUID()
      inv3Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Org ${testRunId}`,
        slug: `org-${testRunId}-006`,
        createdAt: Date.now(),
      })

      // 2 pending
      await store.invitationCollection.insertOne({
        id: inv1Id,
        email: "pending1@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: inv2Id,
        email: "pending2@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })

      // 1 accepted
      await store.invitationCollection.insertOne({
        id: inv3Id,
        email: "accepted@example.com",
        role: "member",
        organizationId: orgId,
        status: "accepted",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv1Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv2Id]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [inv3Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("findPending returns only pending invitations", async () => {
      await store.invitationCollection.loadAll()

      const pending = store.invitationCollection.findPending()

      // Should have at least 2 pending from this test (may have others from other tests)
      const thisTestPending = pending.filter((i: any) =>
        i.email === "pending1@example.com" || i.email === "pending2@example.com"
      )
      expect(thisTestPending).toHaveLength(2)
      expect(pending.every((i: any) => i.status === "pending")).toBe(true)
    })
  })

  // ============================================================
  // test-collection-views-007: Existing findByUserId still works
  // ============================================================
  describe("test-collection-views-007: findByUserId still works", () => {
    let orgId: string
    let teamId: string
    let mem1Id: string
    let mem2Id: string
    let mem3Id: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      teamId = crypto.randomUUID()
      mem1Id = crypto.randomUUID()
      mem2Id = crypto.randomUUID()
      mem3Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Org ${testRunId}`,
        slug: `org-${testRunId}-007`,
        createdAt: Date.now(),
      })

      await store.teamCollection.insertOne({
        id: teamId,
        name: "Team",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // user-1 has 2 memberships
      await store.memberCollection.insertOne({
        id: mem1Id,
        userId: "user-1",
        role: "owner",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      await store.memberCollection.insertOne({
        id: mem2Id,
        userId: "user-1",
        role: "member",
        teamId: teamId,
        createdAt: Date.now(),
      })

      // user-2 has 1 membership
      await store.memberCollection.insertOne({
        id: mem3Id,
        userId: "user-2",
        role: "viewer",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem1Id]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem2Id]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem3Id]])
      await executor.execute(["DELETE FROM studio_core__team WHERE id = $1", [teamId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("findByUserId returns 2 members for user-1", async () => {
      await store.memberCollection.loadAll()

      const user1Members = store.memberCollection.findByUserId("user-1")

      expect(user1Members).toHaveLength(2)
      expect(user1Members.every((m: any) => m.userId === "user-1")).toBe(true)
    })
  })

  // ============================================================
  // test-collection-views-008: Existing findForResource still works
  // ============================================================
  describe("test-collection-views-008: MemberCollection.findForResource still works", () => {
    let org1Id: string
    let org2Id: string
    let mem1Id: string
    let mem2Id: string
    let mem3Id: string
    let mem4Id: string

    beforeEach(async () => {
      org1Id = crypto.randomUUID()
      org2Id = crypto.randomUUID()
      mem1Id = crypto.randomUUID()
      mem2Id = crypto.randomUUID()
      mem3Id = crypto.randomUUID()
      mem4Id = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: org1Id,
        name: `Org 1 ${testRunId}`,
        slug: `org-1-${testRunId}-008`,
        createdAt: Date.now(),
      })

      await store.organizationCollection.insertOne({
        id: org2Id,
        name: `Org 2 ${testRunId}`,
        slug: `org-2-${testRunId}-008`,
        createdAt: Date.now(),
      })

      // 3 members for org1
      await store.memberCollection.insertOne({
        id: mem1Id,
        userId: "user-a",
        role: "owner",
        organizationId: org1Id,
        createdAt: Date.now(),
      })

      await store.memberCollection.insertOne({
        id: mem2Id,
        userId: "user-b",
        role: "admin",
        organizationId: org1Id,
        createdAt: Date.now(),
      })

      await store.memberCollection.insertOne({
        id: mem3Id,
        userId: "user-c",
        role: "member",
        organizationId: org1Id,
        createdAt: Date.now(),
      })

      // 1 member for org2
      await store.memberCollection.insertOne({
        id: mem4Id,
        userId: "user-d",
        role: "owner",
        organizationId: org2Id,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem1Id]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem2Id]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem3Id]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [mem4Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org1Id]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [org2Id]])
    })

    test("findForResource returns 3 members for org1", async () => {
      await store.memberCollection.loadAll()

      const org1Members = store.memberCollection.findForResource("organization", org1Id)

      expect(org1Members).toHaveLength(3)
      expect(org1Members.every((m: any) => m.organization?.id === org1Id)).toBe(true)
    })
  })
})
