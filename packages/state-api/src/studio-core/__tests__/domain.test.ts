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
// Test: StudioCoreDomain ArkType scope defines all entities
// ============================================================
describe("StudioCoreDomain ArkType scope defines all entities", () => {
  test("Scope includes Workspace entity", () => {
    expect(StudioCoreDomain).toBeDefined()
    const types = StudioCoreDomain.export()
    expect(types.Workspace).toBeDefined()
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

  test("Workspace accepts valid UUID id", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Workspace",
      slug: "test-workspace",
      createdAt: Date.now(),
    })
    expect(ws).toBeDefined()
    expect(ws.id).toBe("550e8400-e29b-41d4-a716-446655440001")
  })

  test("Member accepts valid UUID id", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Workspace",
      slug: "test-workspace",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      workspace: ws.id,
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

  test("Project.workspace resolves to Workspace instance", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "My Project",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    expect(project.workspace).toBe(ws)
    expect(project.workspace?.name).toBe("Acme Corp")
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "owner",
      workspace: ws.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(40)
  })

  test("Admin role returns 30", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "admin",
      workspace: ws.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(30)
  })

  test("Member role returns 20", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "member",
      workspace: ws.id,
      createdAt: Date.now(),
    })

    expect(member.level).toBe(20)
  })

  test("Viewer role returns 10", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-123",
      role: "viewer",
      workspace: ws.id,
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "invitee@example.com",
      role: "member",
      workspace: ws.id,
      status: "pending",
      expiresAt: Date.now() - 3600000, // 1 hour ago
      createdAt: Date.now(),
    })

    expect(invitation.isExpired).toBe(true)
  })

  test("Future expiration returns false", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "invitee@example.com",
      role: "member",
      workspace: ws.id,
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Workspace",
      slug: "test-workspace",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    // User 1 has 2 memberships
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      workspace: ws.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      project: project.id,
      createdAt: Date.now(),
    })

    // User 2 has 1 membership
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      userId: "user-2",
      role: "viewer",
      workspace: ws.id,
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

  test("Returns only members with matching workspace", () => {
    const ws1 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Workspace 1",
      slug: "workspace-1",
      createdAt: Date.now(),
    })

    const ws2 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Workspace 2",
      slug: "workspace-2",
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      workspace: ws1.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-2",
      role: "admin",
      workspace: ws2.id,
      createdAt: Date.now(),
    })

    const wsMembers = store.memberCollection.findForResource("workspace", ws1.id)
    expect(wsMembers).toHaveLength(1)
    expect(wsMembers[0].userId).toBe("user-1")
  })

  test("Returns only members with matching project", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      workspace: ws.id,
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
// Test: ProjectCollection.findByWorkspace query
// ============================================================
describe("ProjectCollection.findByWorkspace query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns all projects for workspace", () => {
    const ws1 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Workspace 1",
      slug: "workspace-1",
      createdAt: Date.now(),
    })

    const ws2 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Workspace 2",
      slug: "workspace-2",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "Project 1",
      workspace: ws1.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      name: "Project 2",
      workspace: ws1.id,
      tier: "starter",
      status: "active",
      createdAt: Date.now(),
    })

    store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      name: "Project 3",
      workspace: ws2.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    const ws1Projects = store.projectCollection.findByWorkspace(ws1.id)
    expect(ws1Projects).toHaveLength(2)
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      email: "user1@example.com",
      role: "member",
      workspace: ws.id,
      status: "pending",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      email: "user2@example.com",
      role: "member",
      workspace: ws.id,
      status: "accepted",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    store.invitationCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      email: "user3@example.com",
      role: "member",
      workspace: ws.id,
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

  test("Returns null when user has no permissions", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const effectiveRole = store.resolvePermissions("user-1", "workspace", ws.id)
    expect(effectiveRole).toBeNull()
  })

  test("Resolves permissions for project resource", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    // User has admin at workspace level
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      workspace: ws.id,
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

  test("Creates member with workspace reference", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const member = store.createMember({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "admin",
      workspace: ws.id,
      createdAt: Date.now(),
    })

    expect(member).toBeDefined()
    expect(member.workspace).toBe(ws)
  })

  test("Creates member with project reference", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      workspace: ws.id,
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    expect(() => {
      store.createMember({
        id: "550e8400-e29b-41d4-a716-446655440010",
        userId: "user-1",
        role: "admin",
        workspace: ws.id,
        project: project.id,
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

  test("Creates invitation with workspace reference", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const invitation = store.createInvitation({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "user@example.com",
      role: "admin",
      workspace: ws.id,
      status: "pending",
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
    })

    expect(invitation).toBeDefined()
    expect(invitation.workspace).toBe(ws)
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
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Web App",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    expect(() => {
      store.createInvitation({
        id: "550e8400-e29b-41d4-a716-446655440020",
        email: "user@example.com",
        role: "admin",
        workspace: ws.id,
        project: project.id,
        status: "pending",
        expiresAt: Date.now() + 3600000,
        createdAt: Date.now(),
      })
    }).toThrow(/exactly one/)
  })
})

// ============================================================
// Test: WorkspaceCollection.findByMembership query
// ============================================================
describe("WorkspaceCollection.findByMembership query works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Returns workspaces where user has membership", () => {
    // Create two workspaces
    const ws1 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Workspace 1",
      slug: "workspace-1",
      createdAt: Date.now(),
    })

    const ws2 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Workspace 2",
      slug: "workspace-2",
      createdAt: Date.now(),
    })

    const ws3 = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Workspace 3",
      slug: "workspace-3",
      createdAt: Date.now(),
    })

    // User 1 has membership in ws1 and ws2
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "owner",
      workspace: ws1.id,
      createdAt: Date.now(),
    })

    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      userId: "user-1",
      role: "member",
      workspace: ws2.id,
      createdAt: Date.now(),
    })

    // User 2 has membership in ws3 only
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      userId: "user-2",
      role: "owner",
      workspace: ws3.id,
      createdAt: Date.now(),
    })

    const user1Workspaces = store.workspaceCollection.findByMembership("user-1")
    expect(user1Workspaces).toHaveLength(2)
    expect(user1Workspaces.map((ws: any) => ws.id)).toContain(ws1.id)
    expect(user1Workspaces.map((ws: any) => ws.id)).toContain(ws2.id)
    expect(user1Workspaces.map((ws: any) => ws.id)).not.toContain(ws3.id)
  })

  test("Returns empty array for user with no memberships", () => {
    store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Workspace 1",
      slug: "workspace-1",
      createdAt: Date.now(),
    })

    const noMemberWorkspaces = store.workspaceCollection.findByMembership("nonexistent-user")
    expect(noMemberWorkspaces).toHaveLength(0)
    expect(Array.isArray(noMemberWorkspaces)).toBe(true)
  })

  test("Does not include workspaces without direct membership", () => {
    const ws = store.workspaceCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now(),
    })

    const project = store.projectCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Engineering",
      workspace: ws.id,
      tier: "pro",
      status: "active",
      createdAt: Date.now(),
    })

    // User has project membership but NOT workspace membership
    store.memberCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      userId: "user-1",
      role: "member",
      project: project.id,
      createdAt: Date.now(),
    })

    // findByMembership should return only direct workspace memberships
    const user1Workspaces = store.workspaceCollection.findByMembership("user-1")
    expect(user1Workspaces).toHaveLength(0)
  })
})

// ============================================================
// Test: rootStore.createWorkspace action
// ============================================================
describe("rootStore.createWorkspace action works", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    const { createStore } = createStudioCoreStore()
    store = createStore(env)
  })

  test("Creates workspace and owner membership with name and description", () => {
    const userId = "user-123"
    const ws = store.createWorkspace("My New Workspace", "A great workspace", userId)

    // Workspace should be created
    expect(ws).toBeDefined()
    expect(ws.name).toBe("My New Workspace")
    expect(ws.description).toBe("A great workspace")
    expect(ws.slug).toBeDefined()

    // Owner membership should be created
    const members = store.memberCollection.findByUserId(userId)
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe("owner")
    expect(members[0].workspace?.id).toBe(ws.id)
  })

  test("Works without description (optional)", () => {
    const userId = "user-456"
    const ws = store.createWorkspace("Simple Workspace", undefined, userId)

    expect(ws).toBeDefined()
    expect(ws.name).toBe("Simple Workspace")
    expect(ws.description).toBeUndefined()

    // Owner membership should still be created
    const members = store.memberCollection.findByUserId(userId)
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe("owner")
  })

  test("Creates workspace before member (correct sequence)", () => {
    const userId = "user-789"
    const ws = store.createWorkspace("Sequenced Workspace", undefined, userId)

    // Verify workspace exists
    const storedWs = store.workspaceCollection.get(ws.id)
    expect(storedWs).toBeDefined()
    expect(storedWs.name).toBe("Sequenced Workspace")

    // Verify member references the workspace correctly
    const members = store.memberCollection.findByUserId(userId)
    expect(members[0].workspace).toBe(storedWs)
  })

  test("Returns the created Workspace instance", () => {
    const userId = "user-abc"
    const ws = store.createWorkspace("Return Test Workspace", undefined, userId)

    // Should return the workspace instance
    expect(ws.id).toBeDefined()
    expect(typeof ws.id).toBe("string")

    // Should be the same instance as stored
    const storedWs = store.workspaceCollection.get(ws.id)
    expect(ws).toBe(storedWs)
  })

  test("Generates unique slug from name", () => {
    const userId = "user-xyz"
    const ws = store.createWorkspace("Test Workspace!", undefined, userId)

    // Slug should be lowercase with dashes
    expect(ws.slug).toMatch(/^[a-z0-9-]+$/)
  })
})
