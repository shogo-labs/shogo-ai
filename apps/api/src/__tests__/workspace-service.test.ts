// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/workspace.service.ts`.
 *
 * Covers all 8 exported functions:
 *   - createPersonalWorkspace
 *   - getWorkspacesForUser
 *   - getWorkspace
 *   - getWorkspaceBySlug
 *   - updateWorkspace
 *   - createPaidWorkspace
 *   - getUserOwnedWorkspaceCount
 *   - hasWorkspaceAccess
 *
 * Strategy: replace `../lib/prisma` with an in-memory stub that mimics the
 * narrow surface the service touches (workspace + member tables and
 * `$transaction`). `nanoid`'s `customAlphabet` is mocked to a stable seed
 * so the generated slug is deterministic.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── In-memory stores ───────────────────────────────────────────────────

let workspaces: Map<string, any>
let members: any[]
let workspaceCreateHook: ((data: any) => any) | null
let memberCreateHook: ((data: any) => any) | null

function resetStores() {
  workspaces = new Map()
  members = []
  workspaceCreateHook = null
  memberCreateHook = null
}
resetStores()

const workspaceTable = {
  create: async (args: any) => {
    if (workspaceCreateHook) return workspaceCreateHook(args)
    const id = `ws_${workspaces.size + 1}`
    const row = { id, ...args.data }
    workspaces.set(id, row)
    return row
  },
  findUnique: async (args: any) => {
    for (const v of workspaces.values()) {
      if (args.where.slug && v.slug === args.where.slug) return v
      if (args.where.id && v.id === args.where.id) return v
    }
    return null
  },
  update: async (args: any) => {
    const existing = workspaces.get(args.where.id)
    if (!existing) throw new Error('not found')
    const merged = { ...existing, ...args.data }
    workspaces.set(args.where.id, merged)
    return merged
  },
}

const memberTable = {
  create: async (args: any) => {
    if (memberCreateHook) return memberCreateHook(args)
    const row = { id: `mem_${members.length + 1}`, ...args.data }
    members.push(row)
    return row
  },
  findMany: async (args: any) => {
    let out = members.filter((m) => m.userId === args.where.userId)
    if (args.where.workspaceId?.not !== undefined) {
      out = out.filter((m) => m.workspaceId != null)
    }
    if (args.include?.workspace) {
      out = out.map((m) => ({ ...m, workspace: workspaces.get(m.workspaceId) ?? null }))
    }
    return out
  },
  findFirst: async (args: any) => {
    const where = args.where
    const m = members.find((row) => {
      if (where.workspaceId && row.workspaceId !== where.workspaceId) return false
      if (where.userId && row.userId !== where.userId) return false
      if (where.role?.in && !where.role.in.includes(row.role)) return false
      return true
    })
    if (!m) return null
    if (args.include?.workspace) {
      return { ...m, workspace: workspaces.get(m.workspaceId) ?? null }
    }
    return m
  },
  count: async (args: any) => {
    return members.filter((m) => {
      if (args.where.userId && m.userId !== args.where.userId) return false
      if (args.where.role && m.role !== args.where.role) return false
      if (args.where.workspaceId?.not !== undefined && m.workspaceId == null) return false
      return true
    }).length
  },
}

const prismaStub: any = {
  workspace: workspaceTable,
  member: memberTable,
  $transaction: async (fn: any) => fn({ workspace: workspaceTable, member: memberTable }),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('nanoid', () => ({
  customAlphabet: () => () => 'abc123',
  nanoid: () => 'abc123',
}))

// Import AFTER mocks
const svc = await import('../services/workspace.service')

beforeEach(() => {
  resetStores()
})

// ──────────────────────────────────────────────────────────────────────
// createPersonalWorkspace
// ──────────────────────────────────────────────────────────────────────

describe('createPersonalWorkspace', () => {
  test('builds slug from first 8 chars of userId (dashes stripped)', async () => {
    const result = await svc.createPersonalWorkspace('aaaa-bbbb-cccc', 'Alice')
    expect(result.workspace.slug).toBe('user-aaaabbb-personal')
    expect(result.workspace.name).toBe('Alice Personal')
    expect(result.member.role).toBe('owner')
    expect(result.member.userId).toBe('aaaa-bbbb-cccc')
    expect(result.member.workspaceId).toBe(result.workspace.id)
  })

  test('falls back to "User" when userName is empty', async () => {
    const result = await svc.createPersonalWorkspace('uid12345-deadbeef', '')
    expect(result.workspace.name).toBe('User Personal')
    expect(result.workspace.slug).toBe('user-uid12345-personal')
  })

  test('userId shorter than 8 chars is handled', async () => {
    const result = await svc.createPersonalWorkspace('short', 'Bob')
    expect(result.workspace.slug).toBe('user-short-personal')
  })

  test('propagates errors from transaction', async () => {
    workspaceCreateHook = () => {
      throw new Error('db down')
    }
    await expect(svc.createPersonalWorkspace('u1', 'X')).rejects.toThrow('db down')
  })
})

// ──────────────────────────────────────────────────────────────────────
// getWorkspacesForUser
// ──────────────────────────────────────────────────────────────────────

describe('getWorkspacesForUser', () => {
  test('returns workspaces flattened with role+isBillingAdmin', async () => {
    workspaces.set('ws_1', { id: 'ws_1', name: 'A', slug: 'a' })
    workspaces.set('ws_2', { id: 'ws_2', name: 'B', slug: 'b' })
    members.push(
      { id: 'm1', userId: 'u1', workspaceId: 'ws_1', role: 'owner', isBillingAdmin: true },
      { id: 'm2', userId: 'u1', workspaceId: 'ws_2', role: 'editor', isBillingAdmin: false },
      { id: 'm3', userId: 'u2', workspaceId: 'ws_1', role: 'viewer', isBillingAdmin: false },
    )
    const out = await svc.getWorkspacesForUser('u1')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 'ws_1', name: 'A', role: 'owner', isBillingAdmin: true })
    expect(out[1]).toMatchObject({ id: 'ws_2', role: 'editor', isBillingAdmin: false })
  })

  test('returns empty array for user with no memberships', async () => {
    const out = await svc.getWorkspacesForUser('ghost')
    expect(out).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// getWorkspace
// ──────────────────────────────────────────────────────────────────────

describe('getWorkspace', () => {
  beforeEach(() => {
    workspaces.set('ws_1', { id: 'ws_1', name: 'W', slug: 'w' })
    members.push({ id: 'm1', userId: 'u1', workspaceId: 'ws_1', role: 'admin', isBillingAdmin: true })
  })

  test('returns workspace with role+billing flag for member', async () => {
    const w = await svc.getWorkspace('ws_1', 'u1')
    expect(w).toMatchObject({ id: 'ws_1', role: 'admin', isBillingAdmin: true })
  })

  test('returns null for non-member', async () => {
    expect(await svc.getWorkspace('ws_1', 'other')).toBeNull()
  })

  test('returns null when member exists but workspace include is missing', async () => {
    members.push({ id: 'm2', userId: 'u2', workspaceId: 'ws_missing', role: 'owner', isBillingAdmin: false })
    expect(await svc.getWorkspace('ws_missing', 'u2')).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// getWorkspaceBySlug
// ──────────────────────────────────────────────────────────────────────

describe('getWorkspaceBySlug', () => {
  test('returns workspace when slug matches', async () => {
    workspaces.set('ws_x', { id: 'ws_x', name: 'X', slug: 'my-slug' })
    expect(await svc.getWorkspaceBySlug('my-slug')).toMatchObject({ id: 'ws_x', slug: 'my-slug' })
  })

  test('returns null on miss', async () => {
    expect(await svc.getWorkspaceBySlug('nope')).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// updateWorkspace
// ──────────────────────────────────────────────────────────────────────

describe('updateWorkspace', () => {
  test('merges fields into existing workspace', async () => {
    workspaces.set('ws_u', { id: 'ws_u', name: 'old', slug: 'old' })
    const out = await svc.updateWorkspace('ws_u', { name: 'new' } as any)
    expect(out).toMatchObject({ id: 'ws_u', name: 'new', slug: 'old' })
  })

  test('throws when workspace does not exist', async () => {
    await expect(svc.updateWorkspace('missing', { name: 'X' } as any)).rejects.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────
// createPaidWorkspace
// ──────────────────────────────────────────────────────────────────────

describe('createPaidWorkspace', () => {
  test('builds kebab slug with nanoid suffix', async () => {
    const r = await svc.createPaidWorkspace('u1', 'Acme Co. & Friends!')
    expect(r.workspace.slug).toBe('acme-co-friends-abc123')
    expect(r.workspace.name).toBe('Acme Co. & Friends!')
    expect(r.member.role).toBe('owner')
    expect(r.member.userId).toBe('u1')
  })

  test('trims leading/trailing dashes from slug', async () => {
    const r = await svc.createPaidWorkspace('u1', '---Foo Bar---')
    expect(r.workspace.slug).toBe('foo-bar-abc123')
  })

  test('handles non-ascii name (empty base + nanoid)', async () => {
    const r = await svc.createPaidWorkspace('u1', '日本語')
    expect(r.workspace.slug).toBe('-abc123')
  })

  test('member-creation failure surfaces to caller', async () => {
    memberCreateHook = () => {
      throw new Error('member fail')
    }
    await expect(svc.createPaidWorkspace('u1', 'Test')).rejects.toThrow('member fail')
  })
})

// ──────────────────────────────────────────────────────────────────────
// getUserOwnedWorkspaceCount
// ──────────────────────────────────────────────────────────────────────

describe('getUserOwnedWorkspaceCount', () => {
  test('counts only owner rows with non-null workspaceId', async () => {
    members.push(
      { id: 'a', userId: 'u1', role: 'owner', workspaceId: 'w1' },
      { id: 'b', userId: 'u1', role: 'owner', workspaceId: 'w2' },
      { id: 'c', userId: 'u1', role: 'editor', workspaceId: 'w3' },
      { id: 'd', userId: 'u1', role: 'owner', workspaceId: null },
      { id: 'e', userId: 'u2', role: 'owner', workspaceId: 'w4' },
    )
    expect(await svc.getUserOwnedWorkspaceCount('u1')).toBe(2)
  })

  test('returns 0 for user with no memberships', async () => {
    expect(await svc.getUserOwnedWorkspaceCount('ghost')).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// hasWorkspaceAccess
// ──────────────────────────────────────────────────────────────────────

describe('hasWorkspaceAccess', () => {
  beforeEach(() => {
    members.push(
      { id: 'm1', userId: 'u1', workspaceId: 'ws_1', role: 'owner' },
      { id: 'm2', userId: 'u2', workspaceId: 'ws_1', role: 'viewer' },
    )
  })

  test('returns true when no role filter', async () => {
    expect(await svc.hasWorkspaceAccess('ws_1', 'u1')).toBe(true)
  })

  test('returns false for non-member', async () => {
    expect(await svc.hasWorkspaceAccess('ws_1', 'ghost')).toBe(false)
  })

  test('returns true when user has one of requiredRoles', async () => {
    expect(await svc.hasWorkspaceAccess('ws_1', 'u1', ['owner', 'admin'])).toBe(true)
  })

  test('returns false when user role not in requiredRoles', async () => {
    expect(await svc.hasWorkspaceAccess('ws_1', 'u2', ['owner', 'admin'])).toBe(false)
  })

  test('returns false when workspaceId does not match', async () => {
    expect(await svc.hasWorkspaceAccess('ws_other', 'u1')).toBe(false)
  })
})
