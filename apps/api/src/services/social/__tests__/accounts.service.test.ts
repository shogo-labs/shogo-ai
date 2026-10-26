// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Account listing and sync against the shapes Zernio returns.
 *
 * `{ accounts: [{ _id, profileId: { _id }, username: "@acme" }] }` is the real
 * document (docs.zernio.com/accounts/list-accounts). Reading `id` dropped every
 * account, and the reconcile pass then deactivated every row we had.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import accountList from './fixtures/zernio-account-list.json'

const store = {
  profiles: [] as any[],
  accounts: [] as any[],
}

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

const dbMock = {
  socialProfile: {
    findUnique: async ({ where }: any) => {
      const key = where?.workspaceId_localWorkspaceId
      if (!key) return store.profiles.find((row) => row.externalId === where.externalId) ?? null
      return (
        store.profiles.find(
          (row) => row.workspaceId === key.workspaceId && row.localWorkspaceId === key.localWorkspaceId,
        ) ?? null
      )
    },
  },
  socialAccount: {
    findMany: async ({ where }: any) =>
      store.accounts.filter(
        (row) =>
          (!where.workspaceId || row.workspaceId === where.workspaceId) &&
          (!where.profileId || row.profileId === where.profileId) &&
          (where.isActive === undefined || row.isActive === where.isActive),
      ),
    findUnique: async ({ where }: any) =>
      store.accounts.find((row) => matches(row, where)) ?? null,
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
    count: async ({ where }: any) =>
      store.accounts.filter(
        (row) => row.workspaceId === where.workspaceId && row.isActive === where.isActive,
      ).length,
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { listAccounts, normalizeZernioAccount, syncAccounts, syncProfileAccounts } = await import(
  '../accounts.service'
)
const { setSocialClient } = await import('../client')

const calls: any[] = []
let responder: (req: any) => any = () => ({ accounts: [] })

const profile = {
  id: 'profile_row_1',
  workspaceId: 'ws_1',
  localWorkspaceId: '',
  zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
  externalId: 'ws_ws_1',
  name: 'Odin AI',
}

beforeEach(() => {
  store.profiles.length = 0
  store.accounts.length = 0
  calls.length = 0
  responder = () => accountList
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      return responder(req)
    },
  })
})

describe('normalizeZernioAccount', () => {
  test('reads Mongo `_id` and strips the `@` off the handle', () => {
    const account = normalizeZernioAccount(accountList.accounts[0])
    expect(account).toMatchObject({
      id: '66aa11bb22cc33dd44ee55ff',
      platform: 'instagram',
      username: 'acme',
      displayName: 'Acme',
    })
  })

  test('still reads a legacy `{ id }` payload', () => {
    expect(normalizeZernioAccount({ id: 'acct_1', platform: 'TikTok', username: '@acme' })).toMatchObject({
      id: 'acct_1',
      platform: 'tiktok',
      username: 'acme',
    })
  })

  test('an account with no id is dropped rather than stored half-baked', () => {
    expect(normalizeZernioAccount({ platform: 'instagram', username: 'acme' })).toBeNull()
  })
})

describe('sync', () => {
  test('one real account becomes one row, and stays active', async () => {
    await syncProfileAccounts(profile)

    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]).toMatchObject({
      zernioAccountId: '66aa11bb22cc33dd44ee55ff',
      platform: 'instagram',
      username: 'acme',
      isActive: true,
    })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/accounts',
      query: { profileId: profile.zernioProfileId },
    })
  })

  test('a brand-new workspace asks the provider nothing and creates no profile', async () => {
    const accounts = await syncAccounts('ws_1', 'Odin AI')

    expect(accounts).toEqual([])
    expect(calls).toHaveLength(0)
    expect(store.profiles).toHaveLength(0)
    expect(store.accounts).toHaveLength(0)
  })

  test('a workspace with a profile reconciles its accounts', async () => {
    store.profiles.push(profile)

    await syncAccounts('ws_1', 'Odin AI')

    expect(calls).toHaveLength(1)
    expect((await listAccounts('ws_1')).map((row: any) => row.username)).toEqual(['acme'])
  })
})
