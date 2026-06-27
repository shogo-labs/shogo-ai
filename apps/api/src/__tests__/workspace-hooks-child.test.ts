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

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// --- Mocked dependencies of workspace.hooks ---------------------------------
let ownedCount = 0
let effectivePlan = 'business'

mock.module('../services/workspace.service', () => ({
  getUserOwnedWorkspaceCount: async () => ownedCount,
}))
mock.module('../services/billing.service', () => ({
  getEffectivePlanId: async () => effectivePlan,
}))
mock.module('../lib/region', () => ({
  homeRegionForNewWorkspace: () => 'us-east',
}))

const { workspaceHooks } = await import('../generated/workspace.hooks')

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
  effectivePlan = 'business'
  workspacesById = {}
  usersById = {}
  updateCalls.length = 0
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

  it('rejects when the parent plan is below Business', async () => {
    effectivePlan = 'pro'
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

describe('workspaceHooks.beforeCreate — personal workspaces (no parent)', () => {
  it('enforces the one-free-workspace limit', async () => {
    ownedCount = 1
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('workspace_limit_reached')
  })

  it('allows the first free personal workspace', async () => {
    ownedCount = 0
    const res = await workspaceHooks.beforeCreate!(
      { name: 'Mine' },
      makeCtx({ userId: 'u1', body: {} }),
    )
    expect(res?.ok).toBe(true)
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
