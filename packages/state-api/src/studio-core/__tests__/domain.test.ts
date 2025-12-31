/**
 * TDD Tests for task-sc-001 (domain-store)
 * Task: Create studio-core domain store with ArkType scope and domain() API
 * Feature: studio-core
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { StudioCoreDomain, createStudioCoreStore, RoleLevels } from "../domain"
import { NullPersistence } from "../../persistence/null"
import type { IEnvironment } from "../../environment/types"

// Helper to create a test environment
function createTestEnv(): IEnvironment {
  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: {
        register: () => {},
        get: () => undefined,
        has: () => false,
        resolve: () => { throw new Error("No backend configured") },
        setDefault: () => {},
      } as any,
    },
    context: {
      schemaName: "test-studio-core",
    },
  }
}

// ============================================================
// Test: StudioCoreDomain ArkType scope defines all 6 entities
// ============================================================
describe("StudioCoreDomain ArkType scope defines all entities", () => {
  test("Scope includes Organization entity", () => {
    expect(StudioCoreDomain).toBeDefined()
    const types = StudioCoreDomain.export()
    expect(types.Organization).toBeDefined()
  })

  test("Scope includes Team entity", () => {
    const types = StudioCoreDomain.export()
    expect(types.Team).toBeDefined()
  })

  test("Scope includes Project entity", () => {
    const types = StudioCoreDomain.export()
    expect(types.Project).toBeDefined()
  })

  test("Scope includes Member entity", () => {
    const types = StudioCoreDomain.export()
    expect(types.Member).toBeDefined()
  })

  test("Scope includes BillingAccount entity", () => {
    const types = StudioCoreDomain.export()
    expect(types.BillingAccount).toBeDefined()
  })

  test("Scope includes Invitation entity", () => {
    const types = StudioCoreDomain.export()
    expect(types.Invitation).toBeDefined()
  })
})

// ============================================================
// Test: Entity identifiers use string.uuid type
// ============================================================
describe("Entity identifiers use string.uuid type", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Organization accepts valid UUID id", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Org",
      slug: "test-org",
      createdAt: Date.now(),
    })
    expect(org).toBeDefined()
    expect(org.id).toBe("550e8400-e29b-41d4-a716-446655440001")
  })

  test("Member accepts valid UUID id", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Org",
      slug: "test-org",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })
    expect(member.id).toBe("550e8400-e29b-41d4-a716-446655440010")
  })
})

// ============================================================
// Test: Entity references use entity name directly
// ============================================================
describe("Entity references use entity name directly", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Team.organization resolves to Organization instance", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(team.organization).toBe(org)
    expect(team.organization?.name).toBe("Acme Corp")
  })

  test("Team.parent resolves to Team instance", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const parentTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    const childTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Frontend",
      organization: org.id,
      parent: parentTeam.id,
      createdAt: Date.now(),
    })

    expect(childTeam.parent).toBe(parentTeam)
  })
})

// ============================================================
// Test: RoleLevels constant defined
// ============================================================
describe("RoleLevels constant defined", () => {
  test("RoleLevels has owner = 40", () => {
    expect(RoleLevels.owner).toBe(40)
  })

  test("RoleLevels has admin = 30", () => {
    expect(RoleLevels.admin).toBe(30)
  })

  test("RoleLevels has member = 20", () => {
    expect(RoleLevels.member).toBe(20)
  })

  test("RoleLevels has viewer = 10", () => {
    expect(RoleLevels.viewer).toBe(10)
  })
})

// ============================================================
// Test: Member.level computed view
// ============================================================
describe("Member.level computed view returns numeric role value", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Owner role returns 40", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "owner",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(40)
  })

  test("Admin role returns 30", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(30)
  })

  test("Member role returns 20", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "member",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(20)
  })

  test("Viewer role returns 10", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "viewer",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(10)
  })
})

// ============================================================
// Test: Invitation.isExpired computed view
// ============================================================
describe("Invitation.isExpired computed view works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Past expiration returns true", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "invitee@example.com",
      role: "member",
      organization: org.id,
      status: "pending",
      expiresAt: Date.now() - 3600000, // 1 hour ago
      createdAt: Date.now(),
    })

    expect(invitation.isExpired).toBe(true)
  })

  test("Future expiration returns false", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "invitee@example.com",
      role: "member",
      organization: org.id,
      status: "pending",
      expiresAt: Date.now() + 3600000, // 1 hour from now
      createdAt: Date.now(),
    })

    expect(invitation.isExpired).toBe(false)
  })
})

// ============================================================
// Test: MemberCollection.findByUserId query
// ============================================================
describe("MemberCollection.findByUserId query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns array of members for user", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    // User 1 has 2 memberships
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      team: team.id,
      createdAt: Date.now(),
    })

    // User 2 has 1 membership
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      userId: "user-2",
      role: "viewer",
      organization: org.id,
      createdAt: Date.now(),
    })

    const user1Members = store.memberCollection.findByUserId("user-1")
    expect(user1Members).toHaveLength(2)
    expect(user1Members.every((m: any) => m.userId === "user-1")).toBe(true)
  })
})

// ============================================================
// Test: MemberCollection.findForResource query
// ============================================================
describe("MemberCollection.findForResource query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns only members with matching organization", () => {
    const org1 = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Org 1",
      slug: "org-1",
      createdAt: Date.now(),
    })

    const org2 = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Org 2",
      slug: "org-2",
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organization: org1.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-2",
      role: "admin",
      organization: org2.id,
      createdAt: Date.now(),
    })

    const orgMembers = store.memberCollection.findForResource("organization", org1.id)
    expect(orgMembers).toHaveLength(1)
    expect(orgMembers[0].userId).toBe("user-1")
  })

  test("Returns only members with matching team", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      team: team.id,
      createdAt: Date.now(),
    })

    const teamMembers = store.memberCollection.findForResource("team", team.id)
    expect(teamMembers).toHaveLength(1)
    expect(teamMembers[0].userId).toBe("user-1")
  })

  test("Returns only members with matching project", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      organization: org.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      project: project.id,
      createdAt: Date.now(),
    })

    const projectMembers = store.memberCollection.findForResource("project", project.id)
    expect(projectMembers).toHaveLength(1)
    expect(projectMembers[0].userId).toBe("user-1")
  })
})

// ============================================================
// Test: ProjectCollection.findByOrganization query
// ============================================================
describe("ProjectCollection.findByOrganization query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns all projects for organization", () => {
    const org1 = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Org 1",
      slug: "org-1",
      createdAt: Date.now(),
    })

    const org2 = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Org 2",
      slug: "org-2",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "Project 1",
      organization: org1.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      name: "Project 2",
      organization: org1.id,
      tier: "starter",
      status: "active",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      name: "Project 3",
      organization: org2.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    const org1Projects = store.projectCollection.findByOrganization(org1.id)
    expect(org1Projects).toHaveLength(2)
  })
})

// ============================================================
// Test: InvitationCollection.findPending query
// ============================================================
describe("InvitationCollection.findPending query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns only invitations with status=pending", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      email: "user1@example.com",
      role: "member",
      organization: org.id,
      status: "pending",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      email: "user2@example.com",
      role: "member",
      organization: org.id,
      status: "accepted",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      email: "user3@example.com",
      role: "member",
      organization: org.id,
      status: "pending",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    const pending = store.invitationCollection.findPending()
    expect(pending).toHaveLength(2)
    expect(pending.every((i: any) => i.status === "pending")).toBe(true)
  })
})

// ============================================================
// Test: resolvePermissions returns max role across hierarchy
// ============================================================
describe("resolvePermissions returns max role across hierarchy", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns higher role from org level when checking team", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    // User has admin at org level
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })

    // User has member at team level (lower)
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      team: team.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", team.id)
    expect(effectiveRole).toBe("admin") // Higher role wins
  })

  test("Returns owner inherited from parent team", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const parentTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    const childTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Frontend",
      organization: org.id,
      parent: parentTeam.id,
      createdAt: Date.now(),
    })

    // User has owner at parent team only
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "owner",
      team: parentTeam.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", childTeam.id)
    expect(effectiveRole).toBe("owner") // Inherited from parent
  })

  test("Returns null when user has no permissions", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", team.id)
    expect(effectiveRole).toBeNull()
  })

  test("Resolves permissions for project resource", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      organization: org.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    // User has admin at org level
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "project", project.id)
    expect(effectiveRole).toBe("admin")
  })
})

// ============================================================
// Test: createMember action with polymorphic validation
// ============================================================
describe("createMember action validates polymorphic references", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Creates member with organization reference", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.createMember({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(member).toBeDefined()
    expect(member.organization).toBe(org)
  })

  test("Creates member with team reference", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    const member = store.createMember({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      team: team.id,
      createdAt: Date.now(),
    })

    expect(member).toBeDefined()
    expect(member.team).toBe(team)
  })

  test("Creates member with project reference", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      organization: org.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    const member = store.createMember({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      project: project.id,
      createdAt: Date.now(),
    })

    expect(member).toBeDefined()
    expect(member.project).toBe(project)
  })

  test("Throws error when no resource reference provided", () => {
    expect(() => {
      store.createMember({
        id: "550e8400-e29b-41d4-a716-446655440010",
        userId: "user-1",
        role: "admin",
        createdAt: Date.now(),
      })
    }).toThrow(/exactly one/)
  })

  test("Throws error when multiple resource references provided", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(() => {
      store.createMember({
        id: "550e8400-e29b-41d4-a716-446655440010",
        userId: "user-1",
        role: "admin",
        organization: org.id,
        team: team.id,
        createdAt: Date.now(),
      })
    }).toThrow(/exactly one/)
  })
})

// ============================================================
// Test: createInvitation action with polymorphic validation
// ============================================================
describe("createInvitation action validates polymorphic references", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Creates invitation with organization reference", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.createInvitation({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "user@example.com",
      role: "admin",
      organization: org.id,
      status: "pending",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    expect(invitation).toBeDefined()
    expect(invitation.organization).toBe(org)
  })

  test("Throws error when no resource reference provided", () => {
    expect(() => {
      store.createInvitation({
        id: "550e8400-e29b-41d4-a716-446655440020",
        email: "user@example.com",
        role: "admin",
        status: "pending",
        expiresAt: Date.now() + 3600000,
        createdAt: Date.now(),
      })
    }).toThrow(/exactly one/)
  })

  test("Throws error when multiple resource references provided", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organization: org.id,
      createdAt: Date.now(),
    })

    expect(() => {
      store.createInvitation({
        id: "550e8400-e29b-41d4-a716-446655440020",
        email: "user@example.com",
        role: "admin",
        organization: org.id,
        team: team.id,
        status: "pending",
        expiresAt: Date.now() + 3600000,
        createdAt: Date.now(),
      })
    }).toThrow(/exactly one/)
  })
})
