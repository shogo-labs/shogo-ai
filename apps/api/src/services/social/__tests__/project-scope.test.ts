// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A connected account belongs to a project (SHO-392).
 *
 * Three things this file pins down, because each one was a way the feature
 * could silently not work:
 *
 *   1. A second Instagram connect must show Instagram's own login page. Without
 *      `forceReauth` the sign-in reuses the account already on the device, the
 *      callback brings back the same `accountId`, and the "new" account is
 *      really the old row updated — which is what made a workspace look capped
 *      at one Instagram.
 *   2. A project's agent sees its own accounts plus the workspace-shared ones,
 *      and nothing else.
 *   3. A connect that lands on an account another project owns is refused, and
 *      the row is not reassigned.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  profiles: [] as any[],
  accounts: [] as any[],
}

/** Enough of Prisma's `where` for the shapes the social services build. */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true
  if (Array.isArray(where.AND)) return where.AND.every((clause: any) => matchWhere(row, clause))
  if (Array.isArray(where.OR)) return where.OR.some((clause: any) => matchWhere(row, clause))
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const operator = value as any
      if (Array.isArray(operator.in)) return operator.in.includes(row[key])
      if ('gt' in operator) return row[key] > operator.gt
      return false
    }
    return row[key] === value
  })
}

const dbMock = {
  socialProfile: {
    findUnique: async ({ where }: any) => {
      const key = where?.workspaceId_localWorkspaceId
      if (!key) return store.profiles.find((row) => row.externalId === where.externalId) ?? null
      return (
        store.profiles.find(
          (row) =>
            row.workspaceId === key.workspaceId && row.localWorkspaceId === key.localWorkspaceId,
        ) ?? null
      )
    },
    create: async ({ data }: any) => {
      const row = { id: `profile_${store.profiles.length + 1}`, ...data }
      store.profiles.push(row)
      return row
    },
  },
  socialAccount: {
    findMany: async ({ where }: any) => store.accounts.filter((row) => matchWhere(row, where)),
    findFirst: async ({ where }: any) => store.accounts.find((row) => matchWhere(row, where)) ?? null,
    findUnique: async ({ where }: any) => store.accounts.find((row) => matchWhere(row, where)) ?? null,
    create: async ({ data }: any) => {
      const row = { id: `acct_${store.accounts.length + 1}`, ...data }
      store.accounts.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = store.accounts.find((candidate) => candidate.id === where.id)
      Object.assign(row, data)
      return row
    },
    count: async ({ where }: any) => store.accounts.filter((row) => matchWhere(row, where)).length,
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { connectUrl, listAccounts, moveAccount, scopedAccountIds, upsertAccount } = await import(
  '../accounts.service'
)
const { setSocialClient } = await import('../client')

const calls: any[] = []

const profile = {
  id: 'profile_1',
  workspaceId: 'ws_1',
  localWorkspaceId: '',
  zernioProfileId: 'zernio_profile_1',
  externalId: 'ws_ws_1',
  name: 'Acme',
}

function account(overrides: Record<string, any>) {
  return {
    id: `acct_${store.accounts.length + 1}`,
    workspaceId: 'ws_1',
    projectId: null,
    profileId: profile.id,
    zernioAccountId: `z_${store.accounts.length + 1}`,
    platform: 'instagram',
    username: 'someone',
    isActive: true,
    needsReconnect: false,
    tokenHealthy: true,
    ...overrides,
  }
}

beforeEach(() => {
  store.profiles.length = 0
  store.accounts.length = 0
  calls.length = 0
  store.profiles.push({ ...profile })
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      return { authUrl: 'https://zernio.test/oauth' }
    },
  })
})

describe('a second Instagram connect signs in fresh', () => {
  test('forceReauth is defaulted when the workspace already has an Instagram', async () => {
    store.accounts.push(account({ username: 'russell.shogo' }))

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://app.test/api/social/connect/return',
    })

    expect(calls[0].query.forceReauth).toBe('true')
  })

  test('the first Instagram connect does not force a reauth', async () => {
    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://app.test/api/social/connect/return',
    })

    expect(calls[0].query.forceReauth).toBeUndefined()
  })

  test('a reconnect keeps the account it is refreshing, so it is not forced', async () => {
    const existing = account({ username: 'russell.shogo' })
    store.accounts.push(existing)

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://app.test/api/social/connect/return',
      reconnectAccountId: existing.id,
    })

    expect(calls[0].query.forceReauth).toBeUndefined()
    expect(calls[0].query.reconnectAccountId).toBe(existing.zernioAccountId)
  })

  test('another platform never carries forceReauth', async () => {
    store.accounts.push(account({ platform: 'tiktok', username: 'russell.shogo' }))

    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'tiktok',
      redirectUrl: 'https://app.test/api/social/connect/return',
    })

    expect(calls[0].query.forceReauth).toBeUndefined()
  })

  test('the owning project rides along on the redirect URL', async () => {
    await connectUrl({
      workspaceId: 'ws_1',
      workspaceName: 'Acme',
      platform: 'instagram',
      redirectUrl: 'https://app.test/api/social/connect/return',
      projectId: 'proj_engage',
    })

    const redirect = new URL(calls[0].query.redirect_url)
    expect(redirect.searchParams.get('projectId')).toBe('proj_engage')
  })
})

describe('ownership is stamped on create and never moved by a sync', () => {
  test('a new row is created with the caller project', async () => {
    const row = await upsertAccount(
      'ws_1',
      profile.id,
      { id: 'z_new', platform: 'instagram', username: 'brand' },
      { projectId: 'proj_engage' },
    )

    expect(row.projectId).toBe('proj_engage')
  })

  test('an existing row keeps its owner even when another project syncs', async () => {
    store.accounts.push(account({ zernioAccountId: 'z_shared', projectId: 'proj_engage' }))

    const row = await upsertAccount(
      'ws_1',
      profile.id,
      { id: 'z_shared', platform: 'instagram', username: 'brand' },
      { projectId: 'proj_other' },
    )

    expect(row.projectId).toBe('proj_engage')
  })

  test('an explicit connect that lands on another project’s account is refused', async () => {
    store.accounts.push(account({ zernioAccountId: 'z_taken', projectId: 'proj_engage' }))

    await expect(
      upsertAccount(
        'ws_1',
        profile.id,
        { id: 'z_taken', platform: 'instagram', username: 'brand' },
        { projectId: 'proj_other', claim: true },
      ),
    ).rejects.toMatchObject({ code: 'account_owned_elsewhere', status: 409 })

    expect(store.accounts[0].projectId).toBe('proj_engage')
  })
})

describe('a project sees its own accounts plus the shared ones', () => {
  beforeEach(() => {
    store.accounts.push(
      account({ username: 'engage', projectId: 'proj_engage' }),
      account({ username: 'other', projectId: 'proj_other' }),
      account({ username: 'shared', projectId: null }),
    )
  })

  test('a project caller is scoped to its own and shared accounts', async () => {
    const rows = await listAccounts('ws_1', 'proj_engage')
    expect(rows.map((row: any) => row.username).sort()).toEqual(['engage', 'shared'])
  })

  test('the workspace agent and the Social page see everything', async () => {
    const rows = await listAccounts('ws_1')
    expect(rows.map((row: any) => row.username).sort()).toEqual(['engage', 'other', 'shared'])
  })

  test('scopedAccountIds is null for an unscoped caller', async () => {
    expect(await scopedAccountIds('ws_1')).toBeNull()
    expect((await scopedAccountIds('ws_1', 'proj_engage'))?.length).toBe(2)
  })
})

describe('moving an account', () => {
  test('moves it to a project and back to shared', async () => {
    const row = account({ username: 'brand', projectId: null })
    store.accounts.push(row)

    expect((await moveAccount('ws_1', row.id, 'proj_engage')).projectId).toBe('proj_engage')
    expect((await moveAccount('ws_1', row.id, null)).projectId).toBeNull()
  })

  test('an account from another workspace is not found', async () => {
    store.accounts.push(account({ workspaceId: 'ws_2' }))
    await expect(moveAccount('ws_1', store.accounts[0].id, 'proj_engage')).rejects.toMatchObject({
      code: 'account_not_found',
    })
  })
})
