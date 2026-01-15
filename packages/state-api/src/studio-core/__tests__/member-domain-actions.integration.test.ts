/**
 * TDD Integration Tests for task-member-domain-actions
 * Task: Add member management domain actions to studio-core rootStore
 * Feature: member-management-invitation
 *
 * Test Specifications:
 * - test-member-domain-001: updateMemberRole successfully changes role when acting user has permission
 * - test-member-domain-002: updateMemberRole rejects when acting user's role level is below target
 * - test-member-domain-003: updateMemberRole rejects when acting user tries to promote above own level
 * - test-member-domain-004: removeMember successfully removes member from organization
 * - test-member-domain-005: removeMember throws error when removing last owner
 * - test-member-domain-006: acceptInvitation creates member and updates invitation status
 * - test-member-domain-007: acceptInvitation rejects expired invitation
 * - test-member-domain-008: acceptInvitation rejects non-pending invitation
 * - test-member-domain-009: declineInvitation updates invitation status to declined
 * - test-member-domain-010: cancelInvitation updates status when acting user has permission
 * - test-member-domain-011: cancelInvitation rejects when acting user lacks permission
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

describeWithPostgres("Member Domain Actions - PostgreSQL Integration", () => {
  let executor: BunPostgresExecutor
  let store: ReturnType<typeof studioCoreDomain.createStore>

  // Test data IDs - generated fresh for each test file run
  const testRunId = crypto.randomUUID().slice(0, 8)

  beforeAll(async () => {
    // Initialize postgres executor
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

  // Create fresh store for each test
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
  // test-member-domain-001: updateMemberRole successfully changes role
  // ============================================================
  describe("test-member-domain-001: updateMemberRole successfully changes role", () => {
    let orgId: string
    let ownerMemberId: string
    let targetMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      ownerMemberId = crypto.randomUUID()
      targetMemberId = crypto.randomUUID()

      // Create org
      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}`,
        createdAt: Date.now(),
      })

      // Create owner member
      await store.memberCollection.insertOne({
        id: ownerMemberId,
        userId: "user-owner",
        role: "owner",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Create target member with role 'member'
      await store.memberCollection.insertOne({
        id: targetMemberId,
        userId: "user-member",
        role: "member",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      // Cleanup
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [ownerMemberId]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [targetMemberId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Owner can update member role to admin", async () => {
      // Act
      await store.updateMemberRole(targetMemberId, "admin", "user-owner")

      // Assert - query database directly to verify persistence
      const result = await store.memberCollection.query().where({ id: targetMemberId }).first()
      expect(result).toBeDefined()
      expect(result!.role).toBe("admin")
      expect(result!.updatedAt).toBeDefined()
      expect(result!.updatedAt).toBeGreaterThan(0)
    })
  })

  // ============================================================
  // test-member-domain-002: updateMemberRole rejects when acting user level below target
  // ============================================================
  describe("test-member-domain-002: updateMemberRole rejects when acting user level below target", () => {
    let orgId: string
    let memberMemberId: string
    let adminMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      memberMemberId = crypto.randomUUID()
      adminMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-002`,
        createdAt: Date.now(),
      })

      // Acting user is 'member' (level 20)
      await store.memberCollection.insertOne({
        id: memberMemberId,
        userId: "user-member",
        role: "member",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Target is 'admin' (level 30) - higher than acting user
      await store.memberCollection.insertOne({
        id: adminMemberId,
        userId: "user-admin",
        role: "admin",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [memberMemberId]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [adminMemberId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Member cannot update admin's role", async () => {
      await expect(
        store.updateMemberRole(adminMemberId, "viewer", "user-member")
      ).rejects.toThrow(/permission/i)

      // Verify role unchanged
      const result = await store.memberCollection.query().where({ id: adminMemberId }).first()
      expect(result!.role).toBe("admin")
    })
  })

  // ============================================================
  // test-member-domain-003: updateMemberRole rejects promotion above own level
  // ============================================================
  describe("test-member-domain-003: updateMemberRole rejects promotion above own level", () => {
    let orgId: string
    let adminMemberId: string
    let targetMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      adminMemberId = crypto.randomUUID()
      targetMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-003`,
        createdAt: Date.now(),
      })

      // Acting user is 'admin' (level 30)
      await store.memberCollection.insertOne({
        id: adminMemberId,
        userId: "user-admin",
        role: "admin",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Target is 'member' (level 20)
      await store.memberCollection.insertOne({
        id: targetMemberId,
        userId: "user-member",
        role: "member",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [adminMemberId]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [targetMemberId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Admin cannot promote member to owner", async () => {
      await expect(
        store.updateMemberRole(targetMemberId, "owner", "user-admin")
      ).rejects.toThrow(/cannot promote above/i)

      // Verify role unchanged
      const result = await store.memberCollection.query().where({ id: targetMemberId }).first()
      expect(result!.role).toBe("member")
    })
  })

  // ============================================================
  // test-member-domain-004: removeMember successfully removes member
  // ============================================================
  describe("test-member-domain-004: removeMember successfully removes member", () => {
    let orgId: string
    let owner1MemberId: string
    let owner2MemberId: string
    let regularMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      owner1MemberId = crypto.randomUUID()
      owner2MemberId = crypto.randomUUID()
      regularMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-004`,
        createdAt: Date.now(),
      })

      // Two owners
      await store.memberCollection.insertOne({
        id: owner1MemberId,
        userId: "user-owner-1",
        role: "owner",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      await store.memberCollection.insertOne({
        id: owner2MemberId,
        userId: "user-owner-2",
        role: "owner",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      // Regular member to remove
      await store.memberCollection.insertOne({
        id: regularMemberId,
        userId: "user-member",
        role: "member",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [owner1MemberId]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [owner2MemberId]])
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [regularMemberId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Owner can remove regular member", async () => {
      await store.removeMember(regularMemberId, "user-owner-1")

      // Verify member deleted
      const result = await store.memberCollection.query().where({ id: regularMemberId }).first()
      expect(result).toBeUndefined()
    })
  })

  // ============================================================
  // test-member-domain-005: removeMember throws error when removing last owner
  // ============================================================
  describe("test-member-domain-005: removeMember throws error when removing last owner", () => {
    let orgId: string
    let singleOwnerMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      singleOwnerMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-005`,
        createdAt: Date.now(),
      })

      // Single owner
      await store.memberCollection.insertOne({
        id: singleOwnerMemberId,
        userId: "user-owner",
        role: "owner",
        organizationId: orgId,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [singleOwnerMemberId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Cannot remove the last owner of an organization", async () => {
      await expect(
        store.removeMember(singleOwnerMemberId, "user-owner")
      ).rejects.toThrow(/Cannot remove the last owner/i)

      // Verify owner still exists
      const result = await store.memberCollection.query().where({ id: singleOwnerMemberId }).first()
      expect(result).toBeDefined()
      expect(result!.role).toBe("owner")
    })
  })

  // ============================================================
  // test-member-domain-006: acceptInvitation creates member and updates status
  // ============================================================
  describe("test-member-domain-006: acceptInvitation creates member and updates status", () => {
    let orgId: string
    let invitationId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      invitationId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-006`,
        createdAt: Date.now(),
      })

      // Create pending invitation (not expired)
      await store.invitationCollection.insertOne({
        id: invitationId,
        email: "invitee@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000, // 24 hours in future
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      // Clean up any created members
      await executor.execute(["DELETE FROM studio_core__member WHERE user_id = $1", ["user-invitee"]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [invitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Accepting invitation creates member and updates status", async () => {
      await store.acceptInvitation(invitationId, "user-invitee")

      // Verify member created
      const members = await store.memberCollection.query().where({ userId: "user-invitee" }).toArray()
      expect(members).toHaveLength(1)
      expect(members[0].role).toBe("member")
      expect(members[0].organizationId).toBe(orgId)

      // Verify invitation status updated
      const invitation = await store.invitationCollection.query().where({ id: invitationId }).first()
      expect(invitation!.status).toBe("accepted")
    })
  })

  // ============================================================
  // test-member-domain-007: acceptInvitation rejects expired invitation
  // ============================================================
  describe("test-member-domain-007: acceptInvitation rejects expired invitation", () => {
    let orgId: string
    let expiredInvitationId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      expiredInvitationId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-007`,
        createdAt: Date.now(),
      })

      // Create expired invitation
      await store.invitationCollection.insertOne({
        id: expiredInvitationId,
        email: "expired@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() - 3600000, // 1 hour ago (expired)
        createdAt: Date.now() - 86400000,
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [expiredInvitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Cannot accept expired invitation", async () => {
      await expect(
        store.acceptInvitation(expiredInvitationId, "user-expired")
      ).rejects.toThrow(/expired/i)

      // Verify no member created
      const members = await store.memberCollection.query().where({ userId: "user-expired" }).toArray()
      expect(members).toHaveLength(0)

      // Verify invitation status unchanged
      const invitation = await store.invitationCollection.query().where({ id: expiredInvitationId }).first()
      expect(invitation!.status).toBe("pending")
    })
  })

  // ============================================================
  // test-member-domain-008: acceptInvitation rejects non-pending invitation
  // ============================================================
  describe("test-member-domain-008: acceptInvitation rejects non-pending invitation", () => {
    let orgId: string
    let declinedInvitationId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      declinedInvitationId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-008`,
        createdAt: Date.now(),
      })

      // Create already declined invitation
      await store.invitationCollection.insertOne({
        id: declinedInvitationId,
        email: "declined@example.com",
        role: "member",
        organizationId: orgId,
        status: "declined",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [declinedInvitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Cannot accept already declined invitation", async () => {
      await expect(
        store.acceptInvitation(declinedInvitationId, "user-declined")
      ).rejects.toThrow(/not pending/i)

      // Verify no member created
      const members = await store.memberCollection.query().where({ userId: "user-declined" }).toArray()
      expect(members).toHaveLength(0)
    })
  })

  // ============================================================
  // test-member-domain-009: declineInvitation updates status to declined
  // ============================================================
  describe("test-member-domain-009: declineInvitation updates status to declined", () => {
    let orgId: string
    let invitationId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      invitationId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-009`,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: invitationId,
        email: "todecline@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [invitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Declining invitation updates status to declined", async () => {
      await store.declineInvitation(invitationId)

      // Verify status updated
      const invitation = await store.invitationCollection.query().where({ id: invitationId }).first()
      expect(invitation!.status).toBe("declined")

      // Verify no member created
      const members = await store.memberCollection.query().where({ userId: "user-decline" }).toArray()
      expect(members).toHaveLength(0)
    })
  })

  // ============================================================
  // test-member-domain-010: cancelInvitation updates status when user has permission
  // ============================================================
  describe("test-member-domain-010: cancelInvitation updates status with permission", () => {
    let orgId: string
    let invitationId: string
    let adminMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      invitationId = crypto.randomUUID()
      adminMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-010`,
        createdAt: Date.now(),
      })

      // Admin user who will cancel
      await store.memberCollection.insertOne({
        id: adminMemberId,
        userId: "user-admin",
        role: "admin",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: invitationId,
        email: "tocancel@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [adminMemberId]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [invitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Admin can cancel pending invitation", async () => {
      await store.cancelInvitation(invitationId, "user-admin")

      // Verify status updated to cancelled
      const invitation = await store.invitationCollection.query().where({ id: invitationId }).first()
      expect(invitation!.status).toBe("cancelled")
    })
  })

  // ============================================================
  // test-member-domain-011: cancelInvitation rejects when user lacks permission
  // ============================================================
  describe("test-member-domain-011: cancelInvitation rejects without permission", () => {
    let orgId: string
    let invitationId: string
    let viewerMemberId: string

    beforeEach(async () => {
      orgId = crypto.randomUUID()
      invitationId = crypto.randomUUID()
      viewerMemberId = crypto.randomUUID()

      await store.organizationCollection.insertOne({
        id: orgId,
        name: `Test Org ${testRunId}`,
        slug: `test-org-${testRunId}-011`,
        createdAt: Date.now(),
      })

      // Viewer user (cannot cancel)
      await store.memberCollection.insertOne({
        id: viewerMemberId,
        userId: "user-viewer",
        role: "viewer",
        organizationId: orgId,
        createdAt: Date.now(),
      })

      await store.invitationCollection.insertOne({
        id: invitationId,
        email: "cantcancel@example.com",
        role: "member",
        organizationId: orgId,
        status: "pending",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      })
    })

    afterEach(async () => {
      await executor.execute(["DELETE FROM studio_core__member WHERE id = $1", [viewerMemberId]])
      await executor.execute(["DELETE FROM studio_core__invitation WHERE id = $1", [invitationId]])
      await executor.execute(["DELETE FROM studio_core__organization WHERE id = $1", [orgId]])
    })

    test("Viewer cannot cancel invitation", async () => {
      await expect(
        store.cancelInvitation(invitationId, "user-viewer")
      ).rejects.toThrow(/permission/i)

      // Verify status unchanged
      const invitation = await store.invitationCollection.query().where({ id: invitationId }).first()
      expect(invitation!.status).toBe("pending")
    })
  })
})
