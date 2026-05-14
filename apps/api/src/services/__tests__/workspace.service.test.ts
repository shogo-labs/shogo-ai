// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  txWorkspaceCreate: any
  txMemberCreate: any
  findManyMembers: any[]
  findFirstMember: any | null
  findUniqueWorkspace: any | null
  updateWorkspaceCalls: any[]
  countResult: number
  hasAccessMember: any | null
  txWorkspaceCreateCalls: any[]
  txMemberCreateCalls: any[]
}

const s: State = {
  txWorkspaceCreate: null,
  txMemberCreate: null,
  findManyMembers: [],
  findFirstMember: null,
  findUniqueWorkspace: null,
  updateWorkspaceCalls: [],
  countResult: 0,
  hasAccessMember: null,
  txWorkspaceCreateCalls: [],
  txMemberCreateCalls: [],
}

const tx = {
  workspace: {
    create: async (args: any) => {
      s.txWorkspaceCreateCalls.push(args)
      return s.txWorkspaceCreate ?? { id: 'ws-new', ...args.data }
    },
  },
  member: {
    create: async (args: any) => {
      s.txMemberCreateCalls.push(args)
      return s.txMemberCreate ?? { id: 'm-new', ...args.data }
    },
  },
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    $transaction: async (cb: any, _opts?: any) => cb(tx),
    member: {
      findMany: async (_args: any) => s.findManyMembers,
      findFirst: async (_args: any) => s.findFirstMember,
      count: async (_args: any) => s.countResult,
    },
    workspace: {
      findUnique: async (_args: any) => s.findUniqueWorkspace,
      update: async (args: any) => {
        s.updateWorkspaceCalls.push(args)
        return { id: args.where.id, ...args.data }
      },
    },
  },
}))

mock.module('nanoid', () => ({
  customAlphabet: (_alpha: string, _n: number) => () => 'abc123',
}))

const {
  createPaidWorkspace,
  createPersonalWorkspace,
  getUserOwnedWorkspaceCount,
  getWorkspace,
  getWorkspaceBySlug,
  getWorkspacesForUser,
  hasWorkspaceAccess,
  updateWorkspace,
} = await import('../workspace.service')

beforeEach(() => {
  s.txWorkspaceCreate = null
  s.txMemberCreate = null
  s.findManyMembers = []
  s.findFirstMember = null
  s.findUniqueWorkspace = null
  s.updateWorkspaceCalls = []
  s.countResult = 0
  s.hasAccessMember = null
  s.txWorkspaceCreateCalls = []
  s.txMemberCreateCalls = []
})

afterEach(() => {})

describe('createPersonalWorkspace', () => {
  it('builds slug from first 8 chars of userId (dashes stripped)', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'Alice Personal', slug: 'user-12ab34c-personal' }
    s.txMemberCreate = { id: 'm-1', userId: 'aaa', role: 'owner', workspaceId: 'ws-1' }
    await createPersonalWorkspace('12ab-34cd-XXXX', 'Alice')
    expect(s.txWorkspaceCreateCalls[0].data.slug).toBe('user-12ab34c-personal')
    expect(s.txWorkspaceCreateCalls[0].data.name).toBe('Alice Personal')
  })

  it("falls back to 'User Personal' when userName is empty", async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'User Personal', slug: 'user-12345678-personal' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPersonalWorkspace('12345678abcdef', '')
    expect(s.txWorkspaceCreateCalls[0].data.name).toBe('User Personal')
  })

  it('creates an owner member who is a billing admin', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'X Personal', slug: 'user-abcdefgh-personal' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPersonalWorkspace('abcdefgh', 'X')
    const memberArgs = s.txMemberCreateCalls[0].data
    expect(memberArgs.role).toBe('owner')
    expect(memberArgs.userId).toBe('abcdefgh')
    expect(memberArgs.workspaceId).toBe('ws-1')
    expect(memberArgs.isBillingAdmin).toBe(true)
  })

  it('returns the flattened workspace + member shape', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'X Personal', slug: 'user-abcdefgh-personal' }
    s.txMemberCreate = {
      id: 'm-1',
      userId: 'abcdefgh',
      role: 'owner',
      workspaceId: 'ws-1',
    }
    const out = await createPersonalWorkspace('abcdefgh', 'X')
    expect(out).toEqual({
      workspace: { id: 'ws-1', name: 'X Personal', slug: 'user-abcdefgh-personal' },
      member: { id: 'm-1', userId: 'abcdefgh', role: 'owner', workspaceId: 'ws-1' },
    })
  })
})

describe('getWorkspacesForUser', () => {
  it('returns workspaces with the user role + billing flag merged in', async () => {
    s.findManyMembers = [
      {
        userId: 'u-1',
        role: 'owner',
        isBillingAdmin: true,
        workspace: { id: 'ws-1', name: 'A', slug: 'a' },
      },
      {
        userId: 'u-1',
        role: 'editor',
        isBillingAdmin: false,
        workspace: { id: 'ws-2', name: 'B', slug: 'b' },
      },
    ]
    const out = await getWorkspacesForUser('u-1')
    expect(out).toEqual([
      { id: 'ws-1', name: 'A', slug: 'a', role: 'owner', isBillingAdmin: true },
      { id: 'ws-2', name: 'B', slug: 'b', role: 'editor', isBillingAdmin: false },
    ])
  })

  it('returns an empty array when the user has no memberships', async () => {
    s.findManyMembers = []
    expect(await getWorkspacesForUser('u-none')).toEqual([])
  })
})

describe('getWorkspace', () => {
  it('returns null when user is not a member', async () => {
    s.findFirstMember = null
    expect(await getWorkspace('ws-1', 'u-1')).toBeNull()
  })

  it('returns null when membership has no workspace join', async () => {
    s.findFirstMember = { role: 'owner', workspace: null }
    expect(await getWorkspace('ws-1', 'u-1')).toBeNull()
  })

  it('returns flattened workspace with role + billing flag', async () => {
    s.findFirstMember = {
      role: 'editor',
      isBillingAdmin: false,
      workspace: { id: 'ws-1', name: 'Team', slug: 'team' },
    }
    const out = await getWorkspace('ws-1', 'u-1')
    expect(out).toEqual({
      id: 'ws-1',
      name: 'Team',
      slug: 'team',
      role: 'editor',
      isBillingAdmin: false,
    })
  })
})

describe('getWorkspaceBySlug', () => {
  it('proxies to prisma.workspace.findUnique', async () => {
    s.findUniqueWorkspace = { id: 'ws-1', slug: 'team' }
    expect(await getWorkspaceBySlug('team')).toEqual({ id: 'ws-1', slug: 'team' })
  })

  it('returns null when not found', async () => {
    s.findUniqueWorkspace = null
    expect(await getWorkspaceBySlug('missing')).toBeNull()
  })
})

describe('updateWorkspace', () => {
  it('forwards id and data to prisma.workspace.update', async () => {
    await updateWorkspace('ws-1', { name: 'Renamed' } as any)
    expect(s.updateWorkspaceCalls).toEqual([{ where: { id: 'ws-1' }, data: { name: 'Renamed' } }])
  })
})

describe('createPaidWorkspace', () => {
  it('builds slug from sanitized name + nanoid suffix', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'Acme Co.', slug: 'acme-co-abc123' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPaidWorkspace('u', 'Acme Co.')
    expect(s.txWorkspaceCreateCalls[0].data.slug).toBe('acme-co-abc123')
    expect(s.txWorkspaceCreateCalls[0].data.name).toBe('Acme Co.')
  })

  it('strips leading and trailing hyphens after sanitization', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: '*** Foo ***', slug: 'foo-abc123' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPaidWorkspace('u', '*** Foo ***')
    expect(s.txWorkspaceCreateCalls[0].data.slug).toBe('foo-abc123')
  })

  it('lowercases and replaces non-alphanumeric runs with single hyphens', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'HELLO World 123', slug: 'hello-world-123-abc123' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPaidWorkspace('u', 'HELLO  World  123')
    expect(s.txWorkspaceCreateCalls[0].data.slug).toBe('hello-world-123-abc123')
  })

  it('creates an owner billing-admin member', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'X', slug: 'x-abc123' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    await createPaidWorkspace('u', 'X')
    expect(s.txMemberCreateCalls[0].data.role).toBe('owner')
    expect(s.txMemberCreateCalls[0].data.isBillingAdmin).toBe(true)
  })

  it('returns flattened result shape', async () => {
    s.txWorkspaceCreate = { id: 'ws-1', name: 'X', slug: 'x-abc123' }
    s.txMemberCreate = { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' }
    const out = await createPaidWorkspace('u', 'X')
    expect(out).toEqual({
      workspace: { id: 'ws-1', name: 'X', slug: 'x-abc123' },
      member: { id: 'm-1', userId: 'u', role: 'owner', workspaceId: 'ws-1' },
    })
  })
})

describe('getUserOwnedWorkspaceCount', () => {
  it('returns the count from prisma', async () => {
    s.countResult = 3
    expect(await getUserOwnedWorkspaceCount('u-1')).toBe(3)
  })

  it('returns 0 when user owns no workspaces', async () => {
    s.countResult = 0
    expect(await getUserOwnedWorkspaceCount('u-1')).toBe(0)
  })
})

describe('hasWorkspaceAccess', () => {
  it('returns true when membership exists', async () => {
    s.findFirstMember = { id: 'm-1' }
    expect(await hasWorkspaceAccess('ws-1', 'u-1')).toBe(true)
  })

  it('returns false when no membership exists', async () => {
    s.findFirstMember = null
    expect(await hasWorkspaceAccess('ws-1', 'u-1')).toBe(false)
  })

  it('accepts required-roles filter and returns true when role matches', async () => {
    s.findFirstMember = { id: 'm-1', role: 'owner' }
    expect(await hasWorkspaceAccess('ws-1', 'u-1', ['owner', 'editor'])).toBe(true)
  })

  it('returns false when required-roles filter excludes the user', async () => {
    s.findFirstMember = null
    expect(await hasWorkspaceAccess('ws-1', 'u-1', ['owner'])).toBe(false)
  })
})
