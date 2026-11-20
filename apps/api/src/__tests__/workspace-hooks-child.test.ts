// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the workspace CRUD hooks' "child workspace" behavior:
 *  - beforeCreate: free child creation for Business/Enterprise admins, the
 *    one-free-workspace limit for personal workspaces, and the various
 *    rejection paths (plan, permission, nesting).
 *  - afterCreate: persisting the parent link.
 *  - beforeDelete: guarding a parent that still has children.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// --- Mocked dependencies of workspace.hooks ---------------------------------
let ownedCount = 0
let ownedCountByKind: Partial<Record<'personal' | 'team', number>> = {}
let effectivePlan = 'business'
// childCountByWorkspaceId controls what prisma.workspace.count returns for
// each parentWorkspaceId when checkIncludedWorkspaceAllowance runs (SHO-474).
let childCountByWorkspaceId: Record<string, number> = {}

mock.module('../services/workspace.service', () => ({
  getUserOwnedWorkspaceCount: async (_userId: string, kind?: 'personal' | 'team') =>
    kind && kind in ownedCountByKind ? (ownedCountByKind[kind] as number) : ownedCount,
}))
mock.module('../services/billing.service', () => ({
  getEffectivePlanId: async () => effectivePlan,
}))
mock.module('../lib/region', () => ({
  homeRegionForNewWorkspace: () => 'us-east',
}))

// --- Fake Prisma ------------------------------------------------------------
interface FakeWorkspace {
  id: string
  parentWorkspaceId?: string | null
  members?: { userId: string; role: string; isBillingAdmin?: boolean }[]
  children?: { id: string }[]
}

let workspacesById: Record<string, FakeWorkspace> = {}
let usersById: Record<string, { role: string }> = {}
const updateCalls: { id: string; data: any }[] = []

// The RBAC engine reads memberships through the global prisma client.
// Also provides workspace.count for checkIncludedWorkspaceAllowance (SHO-474).
const enginePrisma = {
  user: {
    findUnique: async ({ where }: any) => usersById[where.id] ?? null,
  },
  member: {
    findMany: async ({ where }: any) => {
      const wsScope = where.OR?.find((w: any) => w.projectId === null)
      const members = wsScope ? workspacesById[wsScope.workspaceId]?.members ?? [] : []
      return members
        .filter((m) => m.userId === where.userId)
        .map((m) => ({ role: m.role, projectId: null, isBillingAdmin: !!m.isBillingAdmin }))
    },
  },
  workspace: {
    findUnique: async ({ where }: any) => workspacesById[where.id] ?? null,
    count: async ({ where }: any) => childCountByWorkspaceId[where.parentWorkspaceId] ?? 0,
  },
}
mock.module('../lib/prisma', () => withPrismaExports({ prisma: enginePrisma }))

const { workspaceHooks } = await import('../generated/workspace.hooks')

function makeCtx(opts: {
  userId?: string
  body?: any
} = {}) {
  return {
    body: opts.body ?? {},
    params: {},
    query: {},
    userId: opts.userId,
    prisma: {
      user: {
        findUnique: async ({ where }: any) => usersById[where.id] ?? null,
      },
      workspace: {
        findUnique: async ({ where }: any) => {
          if (where.slug !== undefined) return null // no slug collisions
          return workspacesById[where.id] ?? null
        },
        update: async ({ where, data }: any) => {
          updateCalls.push({ id: where.id, data })
          return { id: where.id, ...data }
        },
      },
      member: {
        create: async () => ({}),
      },
    },
  } as any
}

beforeEach(() => {
  ownedCount = 0
  ownedCountByKind = {}
  effectivePlan = 'business'
  workspacesById = {}
  usersById = {}
  childCountByWorkspaceId = {}
  updateCalls.length = 0
  // Ensure cloud-mode enforcement runs (plan checks are skipped in local mode).
  delete process.env.SHOGO_LOCAL_MODE
})

afterEach(() => {
  // Restore whatever the outer environment had (may be 'true' on a dev box).
  process.env.SHOGO_LOCAL_MODE = 'true'
})

describe('workspaceHooks.beforeCreate — child workspaces', () => {
  it('allows a free child for a Business-plan owner and bypasses the one-free limit', async () => {
    ownedCount = 5 // would normally block a personal workspace
    effectivePlan = 'business'
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('allows a free child for an Enterprise-plan admin', async () => {
    effectivePlan = 'enterprise'
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u2', role: 'admin' }],
    }
    usersById['u2'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team B' },
      makeCtx({ userId: 'u2', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('allows unlimited children for an Enterprise-plan parent', async () => {
    effectivePlan = 'enterprise'
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u2', role: 'owner' }],
      children: Array.from({ length: 100 }, (_, index) => ({ id: `child-${index}` })),
    }
    usersById['u2'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team 101' },
      makeCtx({ userId: 'u2', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('rejects with plan_required when the parent plan is free', async () => {
    effectivePlan = 'free'
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('plan_required')
    expect(res?.error?.message).toMatch(/Basic/)
  })

  it('allows a child under a Basic-plan owner when under the limit', async () => {
    effectivePlan = 'basic' // Basic covers 3 total (1 parent + 2 children)
    childCountByWorkspaceId['parent'] = 1 // 1 child already, used=2 < limit=3
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('rejects when a Basic parent is at its 3-workspace cap', async () => {
    effectivePlan = 'basic' // limit=3, 2 existing children → used=3 >= limit
    childCountByWorkspaceId['parent'] = 2
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
    expect((res?.error as any)?.limit).toBe(3)
    expect((res?.error as any)?.used).toBe(3)
    expect((res?.error as any)?.nextPlanId).toBe('business')
  })

  it('allows a child under a Pro-plan owner within the 10-workspace limit', async () => {
    effectivePlan = 'pro' // limit=10
    childCountByWorkspaceId['parent'] = 5
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('rejects when a Pro parent is at its 10-workspace cap', async () => {
    effectivePlan = 'pro' // limit=10, 9 children → used=10 >= limit
    childCountByWorkspaceId['parent'] = 9
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
    expect((res?.error as any)?.limit).toBe(10)
    expect((res?.error as any)?.used).toBe(10)
    expect((res?.error as any)?.nextPlanId).toBe('business')
  })

  it('rejects when the caller is not an owner/admin of the parent', async () => {
    effectivePlan = 'business'
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: null,
      members: [{ userId: 'someone-else', role: 'owner' }, { userId: 'u1', role: 'member' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('forbidden')
  })

  it('rejects nesting under a workspace that is itself a child', async () => {
    workspacesById['parent'] = {
      id: 'parent',
      parentWorkspaceId: 'grandparent', // already a child
      members: [{ userId: 'u1', role: 'owner' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('invalid_parent')
  })

  it('rejects when the parent does not exist', async () => {
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Team A' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'ghost' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('not_found')
  })
})

describe('workspaceHooks.beforeCreate — top-level workspaces (no parent)', () => {
  it('enforces the one-free-workspace-per-kind limit for the default (team) kind', async () => {
    ownedCount = 1
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
  })

  it('allows the first free (team-kind, default) workspace', async () => {
    ownedCount = 0
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(res?.ok).toBe(true)
  })

  it('allows a free team workspace for a user who already owns a personal workspace', async () => {
    // Every account gets one free workspace of EACH kind — owning a
    // `personal` workspace doesn't use up the free `team` allowance.
    ownedCountByKind = { personal: 1, team: 0 }
    const res = await workspaceHooks.beforeCreate!(
      { name: 'My Team' },
      makeCtx({ userId: 'u1', body: {} }), // kind omitted -> defaults to 'team'
    )
    expect(res?.ok).toBe(true)
  })

  it('blocks a second free team workspace even if the user owns no personal workspace', async () => {
    ownedCountByKind = { personal: 0, team: 1 }
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Another Team' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
    expect(res?.error?.message).toMatch(/Basic|free workspace/)
  })

  it('allows a free personal workspace for a user who already owns a team workspace', async () => {
    ownedCountByKind = { personal: 0, team: 1 }
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine', kind: 'personal' },
      makeCtx({ userId: 'u1', body: { kind: 'personal' } }),
    )
    expect(res?.ok).toBe(true)
  })

  it('blocks a second free personal workspace', async () => {
    ownedCountByKind = { personal: 1, team: 0 }
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine again', kind: 'personal' },
      makeCtx({ userId: 'u1', body: { kind: 'personal' } }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
    expect(res?.error?.message).toMatch(/personal workspace/)
  })
})

describe('workspaceHooks.afterCreate — parent link persistence', () => {
  it('writes parentWorkspaceId for a child workspace', async () => {
    await workspaceHooks.afterCreate!(
      { id: 'child-1' },
      makeCtx({ userId: 'u1', body: { parentWorkspaceId: 'parent' } }),
    )
    const link = updateCalls.find((u) => u.id === 'child-1')
    expect(link?.data?.parentWorkspaceId).toBe('parent')
  })

  it('does not write a parent link for a top-level workspace', async () => {
    await workspaceHooks.afterCreate!(
      { id: 'ws-1' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(updateCalls.find((u) => u.id === 'ws-1')).toBeUndefined()
  })
})

describe('workspaceHooks.beforeDelete — child guard', () => {
  it('blocks deleting a workspace that still has children', async () => {
    workspacesById['parent'] = {
      id: 'parent',
      members: [{ userId: 'u1', role: 'owner' }],
      children: [{ id: 'child-1' }],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeDelete!('parent', makeCtx({ userId: 'u1' }))
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('has_child_workspaces')
  })

  it('blocks even a super admin while children exist', async () => {
    workspacesById['parent'] = {
      id: 'parent',
      members: [],
      children: [{ id: 'child-1' }],
    }
    usersById['admin'] = { role: 'super_admin' }

    const res = await workspaceHooks.beforeDelete!('parent', makeCtx({ userId: 'admin' }))
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('has_child_workspaces')
  })

  it('allows an owner to delete a workspace with no children', async () => {
    workspacesById['solo'] = {
      id: 'solo',
      members: [{ userId: 'u1', role: 'owner' }],
      children: [],
    }
    usersById['u1'] = { role: 'user' }

    const res = await workspaceHooks.beforeDelete!('solo', makeCtx({ userId: 'u1' }))
    expect(res?.ok).toBe(true)
  })
})

describe('workspaceHooks.beforeUpdate — training data mode', () => {
  it('accepts the supported consent modes for an admin', async () => {
    workspacesById['ws-1'] = {
      id: 'ws-1',
      members: [{ userId: 'u1', role: 'admin' }],
    }
    for (const trainingDataMode of ['default', 'enabled', 'disabled']) {
      const res = await workspaceHooks.beforeUpdate!(
        'ws-1',
        { trainingDataMode },
        makeCtx({ userId: 'u1' }),
      )
      expect(res?.ok).toBe(true)
    }
  })

  it('rejects unknown consent modes', async () => {
    workspacesById['ws-1'] = {
      id: 'ws-1',
      members: [{ userId: 'u1', role: 'owner' }],
    }
    const res = await workspaceHooks.beforeUpdate!(
      'ws-1',
      { trainingDataMode: 'always' },
      makeCtx({ userId: 'u1' }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('invalid_training_data_mode')
  })
})
