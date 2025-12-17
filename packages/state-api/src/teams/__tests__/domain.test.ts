/**
 * Generated from TestSpecifications for task-teams-domain-store
 * Task: teams-domain-store
 * Requirements: req-org-entity, req-permission-cascade
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { TeamsDomain, createTeamsStore } from "../domain"
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
      schemaName: "test-teams",
    },
  }
}

// ============================================================
// Test: TeamsDomain ArkType scope defines all entities
// ============================================================
describe("TeamsDomain ArkType scope defines all entities", () => {
  test("Scope includes Organization entity with id, name, slug, description, createdAt", () => {
    expect(TeamsDomain).toBeDefined()
    const types = TeamsDomain.export()
    expect(types.Organization).toBeDefined()
  })

  test("Scope includes Team entity with id, name, organizationId, parentId, createdAt", () => {
    const types = TeamsDomain.export()
    expect(types.Team).toBeDefined()
  })

  test("Scope includes Membership entity with id, userId, role, organizationId, teamId, createdAt", () => {
    const types = TeamsDomain.export()
    expect(types.Membership).toBeDefined()
  })

  test("Scope includes App entity with id, name, teamId, createdAt", () => {
    const types = TeamsDomain.export()
    expect(types.App).toBeDefined()
  })

  test("Scope includes Invitation entity with id, email, role, status, expiresAt, createdAt", () => {
    const types = TeamsDomain.export()
    expect(types.Invitation).toBeDefined()
  })
})

// ============================================================
// Test: createTeamsStore factory uses createStoreFromScope
// ============================================================
describe("createTeamsStore factory uses createStoreFromScope", () => {
  test("Returns object with createStore function", () => {
    const result = createTeamsStore()
    expect(result.createStore).toBeDefined()
    expect(typeof result.createStore).toBe("function")
  })

  test("Returns object with RootStoreModel", () => {
    const result = createTeamsStore()
    expect(result.RootStoreModel).toBeDefined()
  })

  test("createStore() returns MST store instance", () => {
    const env = createTestEnv()
    const { createStore } = createTeamsStore()
    const store = createStore(env)
    expect(store).toBeDefined()
    expect(store.organizationCollection).toBeDefined()
    expect(store.teamCollection).toBeDefined()
    expect(store.membershipCollection).toBeDefined()
    expect(store.appCollection).toBeDefined()
    expect(store.invitationCollection).toBeDefined()
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
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Entity is added successfully with valid UUID id", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Org",
      slug: "test-org",
      createdAt: Date.now(),
    })
    expect(org).toBeDefined()
    expect(org.id).toBe("550e8400-e29b-41d4-a716-446655440001")
  })

  test("Entity can be retrieved by id", () => {
    store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Org",
      slug: "test-org",
      createdAt: Date.now(),
    })
    const retrieved = store.organizationCollection.get("550e8400-e29b-41d4-a716-446655440001")
    expect(retrieved).toBeDefined()
    expect(retrieved.name).toBe("Test Org")
  })
})

// ============================================================
// Test: Team.organization resolves to Organization entity
// ============================================================
describe("Team.organization resolves to Organization entity", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Reference resolves to Organization instance (not just string)", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // Reference should resolve to the actual Organization instance
    expect(team.organizationId).toBe(org)
  })

  test("Organization has correct name and slug properties", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(team.organizationId?.name).toBe("Acme Corp")
    expect(team.organizationId?.slug).toBe("acme")
  })
})

// ============================================================
// Test: Team.parent is optional and resolves correctly
// ============================================================
describe("Team.parent is optional and resolves correctly", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Child team's parent resolves to parent Team instance", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const parentTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const childTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Frontend",
      organizationId: org.id,
      parentId: parentTeam.id,
      createdAt: Date.now(),
    })

    // parentId reference should resolve to parent Team instance
    expect(childTeam.parentId).toBe(parentTeam)
  })

  test("Root team's parent returns undefined", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const rootTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(rootTeam.parentId).toBeUndefined()
  })
})

// ============================================================
// Test: Membership references are polymorphic and optional
// ============================================================
describe("Membership references are polymorphic and optional", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Membership with only organizationId resolves org correctly", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.organizationId).toBe(org)
  })

  test("Membership with only teamId resolves team correctly", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    expect(membership.teamId).toBe(team)
  })

  test("Organization reference returns undefined when teamId is set", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    expect(membership.organizationId).toBeUndefined()
  })

  test("Team reference returns undefined when organizationId is set", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.teamId).toBeUndefined()
  })
})

// ============================================================
// Test: Membership.level computed returns numeric role value
// ============================================================
describe("Membership.level computed returns numeric role value", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Owner role returns 40", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "owner",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.level).toBe(40)
  })

  test("Admin role returns 30", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.level).toBe(30)
  })

  test("Member role returns 20", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "member",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.level).toBe(20)
  })

  test("Viewer role returns 10", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const membership = store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "viewer",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    expect(membership.level).toBe(10)
  })
})

// ============================================================
// Test: Invitation.isExpired computed view works
// ============================================================
describe("Invitation.isExpired computed view works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
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
      organizationId: org.id,
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
      organizationId: org.id,
      status: "pending",
      expiresAt: Date.now() + 3600000, // 1 hour from now
      createdAt: Date.now(),
    })

    expect(invitation.isExpired).toBe(false)
  })
})

// ============================================================
// Test: membershipCollection.findByUserId query works
// ============================================================
describe("membershipCollection.findByUserId query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Returns array of memberships for user", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // User 1 has 2 memberships
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    // User 2 has 1 membership
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      userId: "user-2",
      role: "viewer",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const user1Memberships = store.membershipCollection.findByUserId("user-1")
    expect(user1Memberships).toHaveLength(2)
  })

  test("All returned memberships have correct userId", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-2",
      role: "viewer",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const user1Memberships = store.membershipCollection.findByUserId("user-1")
    expect(user1Memberships.every((m: any) => m.userId === "user-1")).toBe(true)
  })
})

// ============================================================
// Test: membershipCollection.findForResource query works
// ============================================================
describe("membershipCollection.findForResource query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
  })

  test("Returns only memberships with matching organizationId", () => {
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

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Team",
      organizationId: org1.id,
      createdAt: Date.now(),
    })

    // Org 1 membership
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organizationId: org1.id,
      createdAt: Date.now(),
    })

    // Org 2 membership
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-2",
      role: "admin",
      organizationId: org2.id,
      createdAt: Date.now(),
    })

    // Team membership (should not be returned for org query)
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      userId: "user-1",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    const orgMemberships = store.membershipCollection.findForResource("organization", org1.id)
    expect(orgMemberships).toHaveLength(1)
    expect(orgMemberships[0].userId).toBe("user-1")
  })

  test("Does not return team memberships for organization query", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // Team membership only
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    const orgMemberships = store.membershipCollection.findForResource("organization", org.id)
    expect(orgMemberships).toHaveLength(0)
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
    const { createStore } = createTeamsStore()
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
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // User has admin at org level
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // User has member at team level (lower)
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      teamId: team.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", team.id)
    expect(effectiveRole).toBe("admin") // Higher role wins
  })

  test("Role level comparison uses numeric values", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    // User has viewer at org level (10)
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "viewer",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "organization", org.id)
    expect(effectiveRole).toBe("viewer")
  })
})

// ============================================================
// Test: resolvePermissions walks nested team hierarchy
// ============================================================
describe("resolvePermissions walks nested team hierarchy", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createTeamsStore()
    store = createStore(env)
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
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const childTeam = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Frontend",
      organizationId: org.id,
      parentId: parentTeam.id,
      createdAt: Date.now(),
    })

    // User has owner at parent team only
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "owner",
      teamId: parentTeam.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", childTeam.id)
    expect(effectiveRole).toBe("owner") // Inherited from parent
  })

  test("Hierarchy traversal stops at org level", () => {
    const org = store.organizationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const team = store.teamCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // User has owner at org level only
    store.membershipCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "owner",
      organizationId: org.id,
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "team", team.id)
    expect(effectiveRole).toBe("owner") // Inherited from org
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
      organizationId: org.id,
      createdAt: Date.now(),
    })

    // No memberships for user-1
    const effectiveRole = store.resolvePermissions("user-1", "team", team.id)
    expect(effectiveRole).toBeNull()
  })
})
