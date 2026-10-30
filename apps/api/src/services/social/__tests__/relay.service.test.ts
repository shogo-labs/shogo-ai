// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud relay against the real provider shapes.
 *
 * Two failures lived here and neither showed up in CI, because every mock fed
 * `{ id }`:
 *
 *   1. a relayed `POST /profiles` answered `{ profile: { _id } }`, so nothing
 *      was recorded and every later relayed call was a 412; and
 *   2. a relayed account check compared `account.id`, so every
 *      `verifyAccountId` call 403'd.
 *
 * A first connect is also the only operation a scope with no profile may make:
 * the relay creates and records the profile, then forwards.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import accountList from './fixtures/zernio-account-list.json'
import connectReply from './fixtures/zernio-connect.json'
import profileConflict from './fixtures/zernio-profile-conflict.json'
import profileCreate from './fixtures/zernio-profile-create.json'
import profileList from './fixtures/zernio-profile-list.json'

const store = {
  profiles: [] as any[],
  accounts: [] as any[],
  posts: [] as any[],
  automations: [] as any[],
  workspaceName: 'Odin AI',
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
    findMany: async ({ where }: any) =>
      store.profiles.filter((row) => !where?.workspaceId || row.workspaceId === where.workspaceId),
    create: async ({ data }: any) => {
      const row = { id: `profile_row_${store.profiles.length + 1}`, createdAt: new Date(), ...data }
      store.profiles.push(row)
      return row
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.workspaceId_localWorkspaceId
      const existing = store.profiles.find(
        (row) => row.workspaceId === key.workspaceId && row.localWorkspaceId === key.localWorkspaceId,
      )
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { id: `profile_row_${store.profiles.length + 1}`, createdAt: new Date(), ...create }
      store.profiles.push(row)
      return row
    },
  },
  socialAccount: {
    findFirst: async ({ where }: any) =>
      store.accounts.find(
        (row) =>
          (!where.workspaceId || row.workspaceId === where.workspaceId) &&
          (!where.zernioAccountId || row.zernioAccountId === where.zernioAccountId),
      ) ?? null,
    findUnique: async ({ where }: any) =>
      store.accounts.find((row) => row.zernioAccountId === where.zernioAccountId) ?? null,
    findMany: async ({ where }: any) =>
      store.accounts.filter((row) => !where?.workspaceId || row.workspaceId === where.workspaceId),
    count: async ({ where }: any) =>
      store.accounts.filter(
        (row) => row.workspaceId === where.workspaceId && row.isActive === where.isActive,
      ).length,
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
  },
  socialPost: {
    findFirst: async ({ where }: any) =>
      store.posts.find((row) => row.zernioPostId === where.zernioPostId) ?? null,
    create: async ({ data }: any) => {
      const row = { id: `post_${store.posts.length + 1}`, targets: [], ...data }
      store.posts.push(row)
      return row
    },
  },
  socialAutomation: {
    findFirst: async ({ where }: any) =>
      store.automations.find((row) => row.zernioResourceId === where.zernioResourceId) ?? null,
  },
  workspace: {
    findUnique: async () => ({ id: 'ws_1', name: store.workspaceName }),
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { relayOperation } = await import('../relay.service')
const { SocialError, setSocialClient, CREATE_POST_TIMEOUT_MS } = await import('../client')

const workspaceId = '11111111-1111-4111-8111-111111111111'
const localWorkspaceId = '22222222-2222-4222-8222-222222222222'
const calls: any[] = []
let responder: (req: any) => any = () => ({})

function relay(args: Partial<Parameters<typeof relayOperation>[0]> = {}) {
  return relayOperation({
    workspaceId,
    localWorkspaceId: '',
    method: 'GET',
    path: '/profiles',
    query: {},
    body: undefined,
    ...args,
  })
}

beforeEach(() => {
  store.profiles.length = 0
  store.accounts.length = 0
  store.posts.length = 0
  store.automations.length = 0
  calls.length = 0
  responder = (req) => {
    if (req.path === '/connect/instagram') return connectReply
    if (req.path === '/accounts') return accountList
    if (req.method === 'POST' && req.path === '/profiles') {
      // Zernio echoes the routing id it was given.
      return { ...profileCreate, profile: { ...profileCreate.profile, externalId: req.body?.externalId } }
    }
    return {}
  }
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      const reply = responder(req)
      if (reply instanceof Error) throw reply
      return reply
    },
  })
})

describe('a relayed profile create', () => {
  test('records the cloud-side row from `{ profile: { _id } }`', async () => {
    const outcome = await relay({ method: 'POST', path: '/profiles', body: { name: 'Odin AI' } })

    expect(outcome.status).toBe(200)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]).toMatchObject({
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
      externalId: `ws_${workspaceId}`,
    })
  })

  test('records one row per local scope, from the scope it was called for', async () => {
    await relay({ method: 'POST', path: '/profiles', body: { name: 'Odin AI' }, localWorkspaceId })

    expect(store.profiles[0]).toMatchObject({
      localWorkspaceId,
      externalId: `lws_${localWorkspaceId}`,
    })
  })

  test('the live 409 names no id, so the filtered list adopts instead', async () => {
    responder = (req) => {
      if (req.method === 'POST' && req.path === '/profiles') {
        return new SocialError(409, profileConflict.error.code, profileConflict.error.message)
      }
      if (req.method === 'GET' && req.path === '/profiles') {
        // The list answers with the tenant's own row, keyed by the routing id.
        return { profiles: [{ ...profileList.profiles[1]!, externalId: `ws_${workspaceId}` }] }
      }
      return {}
    }

    const outcome = await relay({ method: 'POST', path: '/profiles', body: { name: 'Odin AI' } })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ profile: { _id: '64f0c2a1b9e4d30012ab34cd' } })
    expect(store.profiles[0].zernioProfileId).toBe('64f0c2a1b9e4d30012ab34cd')
    expect(calls.at(-1).query).toEqual({ externalId: `ws_${workspaceId}` })
  })

  test('a 409 adopts the named profile instead of failing the desktop', async () => {
    responder = (req) => {
      if (req.method === 'POST' && req.path === '/profiles') {
        return new SocialError(409, 'profile_external_id_conflict', 'already exists', {
          existingProfileId: '64f0c2a1b9e4d30012ab34cd',
        })
      }
      return {}
    }

    const outcome = await relay({ method: 'POST', path: '/profiles', body: { name: 'Odin AI' } })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ profile: { _id: '64f0c2a1b9e4d30012ab34cd' } })
    expect(store.profiles[0].zernioProfileId).toBe('64f0c2a1b9e4d30012ab34cd')
  })
})

describe('a relayed connect', () => {
  test('for a scope with no profile, creates and records it, then forwards', async () => {
    const outcome = await relay({
      path: '/connect/instagram',
      query: { redirect_url: 'https://app.example/callback' },
    })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ authUrl: connectReply.authUrl })
    expect(store.profiles).toHaveLength(1)

    const forwarded = calls.at(-1)
    expect(forwarded).toMatchObject({
      method: 'GET',
      path: '/connect/instagram',
      query: { profileId: '64f0c2a1b9e4d30012ab34cd', redirect_url: 'https://app.example/callback' },
    })
  })

  test('for a scope that has a profile, forwards without creating another', async () => {
    store.profiles.push({
      id: 'profile_row_1',
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
      externalId: `ws_${workspaceId}`,
      name: 'Odin AI',
    })

    const outcome = await relay({ path: '/connect/tiktok' })

    expect(outcome.status).toBe(200)
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    expect(calls.at(-1).query.profileId).toBe('64f0c2a1b9e4d30012ab34cd')
  })
})

describe('a relayed account call', () => {
  test('recording `{ accounts: [{ _id }] }` makes the account addressable', async () => {
    store.profiles.push({
      id: 'profile_row_1',
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
      externalId: `ws_${workspaceId}`,
      name: 'Odin AI',
    })

    await relay({ path: '/accounts' })
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]).toMatchObject({
      zernioAccountId: '66aa11bb22cc33dd44ee55ff',
      username: 'acme',
    })

    // The row exists locally, so the id verifies without a second provider read.
    const deleted = await relay({ method: 'DELETE', path: '/accounts/66aa11bb22cc33dd44ee55ff' })
    expect(deleted.status).toBe(200)
  })

  test('an account id from another workspace is refused', async () => {
    store.profiles.push({
      id: 'profile_row_1',
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
      externalId: `ws_${workspaceId}`,
      name: 'Odin AI',
    })
    responder = (req) => (req.path === '/accounts' ? { accounts: [] } : {})

    const outcome = await relay({ method: 'DELETE', path: '/accounts/someone_elses_account' })

    expect(outcome.status).toBe(403)
    expect(outcome.body).toMatchObject({ error: { code: 'account_out_of_scope' } })
  })
})

/**
 * The publish budget has to survive the relay hop, or the desktop's 120 s only
 * covers its own wait for Shogo Cloud while the call that actually waits for
 * Zernio still aborts at the 15 s read default — which is how a 34 MB reel
 * "failed" after Instagram had accepted it.
 */
describe('a relayed publish', () => {
  const profileRow = {
    id: 'profile_row_1',
    workspaceId,
    localWorkspaceId: '',
    zernioProfileId: '64f0c2a1b9e4d30012ab34cd',
    externalId: `ws_${workspaceId}`,
    name: 'Odin AI',
  }

  test('the create carries the publish budget, not the read default', async () => {
    store.profiles.push({ ...profileRow })
    responder = (req) => (req.method === 'POST' && req.path === '/posts' ? { post: { _id: 'zpost_1' } } : {})

    const outcome = await relay({
      method: 'POST',
      path: '/posts',
      body: {
        content: 'a 34 MB reel',
        publishNow: true,
        platforms: [{ platform: 'instagram', accountId: '66aa11bb22cc33dd44ee55ff' }],
        mediaItems: [{ url: 'https://cdn.example/reel.mp4', type: 'video' }],
      },
    })

    expect(outcome.status).toBe(200)
    const create = calls.find((call) => call.method === 'POST' && call.path === '/posts')
    expect(CREATE_POST_TIMEOUT_MS).toBe(120_000)
    expect(create.timeoutMs).toBe(CREATE_POST_TIMEOUT_MS)
  })

  test('a read keeps the default budget', async () => {
    store.profiles.push({ ...profileRow })

    await relay({ path: '/posts' })

    expect(calls.at(-1).path).toBe('/posts')
    expect(calls.at(-1).timeoutMs).toBeUndefined()
  })
})
