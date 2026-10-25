// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-202 acceptance — a workspace that has never connected anything gets a
 * sign-in link on its first try: on cloud, through the desktop relay, and when
 * an earlier failed attempt already left a profile behind at Zernio.
 *
 * Zernio is a real HTTP server answering the documents it documents (`_id`
 * inside `{ profile }` / `{ profiles: [] }` / `{ accounts: [] }`), so the real
 * client, the real error normalisation, the real relay planner, the real
 * routers and a real SQLite database all take part. Only the vendor is fake.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { socialRoutes, socialRelayRoutes } = await import('../../../routes/social')
const { setSocialClient } = await import('../client')

const db = prisma as any

interface ProviderCall {
  method: string
  path: string
  query: Record<string, string>
  body: any
}

/** A Zernio stand-in that answers the shapes its docs describe. */
function startZernio() {
  const state = {
    profiles: [] as any[],
    accounts: [] as any[],
    calls: [] as ProviderCall[],
    /** Force the create to fail, the way a rejected payload would. */
    createFails: null as null | { status: number; body: unknown },
    /**
     * The live API answers a duplicate externalId with a bare
     * `invalid_request_error` and no id, not the `profile_external_id_conflict`
     * the docs promise. Keep both, because adoption has to work either way.
     */
    conflictStyle: 'documented' as 'documented' | 'live',
  }
  let seq = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/^\/api\/v1/, '')
      const raw = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text()
      let body: any = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          return Response.json({ error: 'bad json' }, { status: 400 })
        }
      }
      state.calls.push({
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams),
        body,
      })
      const json = (value: unknown, status = 200) => Response.json(value as any, { status })

      if (path === '/profiles' && req.method === 'POST') {
        if (state.createFails) return json(state.createFails.body, state.createFails.status)
        const existing = state.profiles.find((profile) => profile.externalId === body?.externalId)
        if (existing) {
          if (state.conflictStyle === 'live') {
            return json(
              {
                error: {
                  code: 'invalid_request_error',
                  message: 'A profile with this externalId already exists',
                },
              },
              409,
            )
          }
          return json(
            {
              error: 'A profile with this externalId already exists',
              type: 'profile_external_id_conflict',
              details: { existingProfileId: existing._id },
            },
            409,
          )
        }
        const profile = {
          _id: `66f0c2a1b9e4d30012ab${String(seq++).padStart(4, '0')}`,
          name: body?.name ?? 'Workspace',
          externalId: body?.externalId,
          createdAt: '2026-10-25T07:00:00.000Z',
        }
        state.profiles.push(profile)
        return json({ message: 'Profile created', profile }, 201)
      }

      if (path === '/profiles' && req.method === 'GET') {
        const externalId = url.searchParams.get('externalId')
        return json({
          profiles: state.profiles.filter((profile) => !externalId || profile.externalId === externalId),
        })
      }

      if (path === '/accounts' && req.method === 'GET') {
        const profileId = url.searchParams.get('profileId')
        return json({
          accounts: state.accounts.filter(
            (account) => !profileId || account.profileId?._id === profileId,
          ),
        })
      }

      if (path.startsWith('/connect/') && req.method === 'GET') {
        const profileId = url.searchParams.get('profileId')
        if (!profileId) return json({ error: 'profileId is required', type: 'validation_error' }, 400)
        const platform = path.slice('/connect/'.length)
        return json({
          authUrl: `https://zernio.test/oauth/${platform}?profile=${profileId}`,
          platform,
          profileId,
        })
      }

      return json({ error: `unexpected ${req.method} ${path}`, type: 'not_found' }, 404)
    },
  })

  return { state, server, base: `http://127.0.0.1:${server.port}/api/v1` }
}

const zernio = startZernio()

const app = new Hono()
app.use('*', async (c, next) => {
  c.set('auth', {
    userId: c.req.header('x-user') ?? null,
    workspaceId: c.req.header('x-workspace') ?? null,
    isAuthenticated: true,
  } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))
app.route('/api', socialRelayRoutes())

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
const workspaces: string[] = []

async function makeWorkspace(label: string): Promise<string> {
  const workspace = await db.workspace.create({
    data: { name: label, slug: `${label.toLowerCase()}-${suffix}`, kind: 'team' },
  })
  await db.member.create({ data: { workspaceId: workspace.id, userId: owner, role: 'owner' } })
  workspaces.push(workspace.id)
  return workspace.id
}

async function makeUser(): Promise<string> {
  const user = await db.user.create({ data: { name: 'owner', email: `sho202-owner-${suffix}@example.com` } })
  return user.id
}

const api = (path: string, init: RequestInit & { userId?: string | null } = {}) => {
  const { userId, ...rest } = init
  return app.request(`/api${path}`, {
    ...rest,
    headers: {
      ...(userId === null ? {} : { 'x-user': userId ?? owner }),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
  })
}

const relay = (path: string, workspaceId: string, scope: string, init: RequestInit = {}) =>
  app.request(`/api/social-relay${path}`, {
    ...init,
    headers: {
      'x-workspace': workspaceId,
      'x-shogo-local-workspace': scope,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const connect = (workspaceId: string, platform = 'instagram') =>
  api(`/workspaces/${workspaceId}/social/connect`, {
    method: 'POST',
    body: JSON.stringify({ platform }),
  })

const syncAccounts = (workspaceId: string) =>
  api(`/workspaces/${workspaceId}/social/accounts/sync`, { method: 'POST' })

let fresh = ''
let alreadyAtZernio = ''
let liveConflict = ''
let anotherTenant = ''
let relayed = ''
const relayScope = crypto.randomUUID()

beforeAll(async () => {
  owner = await makeUser()
  fresh = await makeWorkspace('SHO202 Fresh')
  alreadyAtZernio = await makeWorkspace('SHO202 Return')
  liveConflict = await makeWorkspace('SHO202 Live Conflict')
  anotherTenant = await makeWorkspace('SHO202 Tenant')
  relayed = await makeWorkspace('SHO202 Relay')

  // This suite is the cloud, whatever the channel DB helper left in the env.
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_API_KEY
  process.env.ZERNIO_API_BASE = zernio.base
  process.env.ZERNIO_API_KEY = 'zernio-test-key'
  setSocialClient(null)
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } }).catch(() => {})
  await db.user.deleteMany({ where: { id: owner } }).catch(() => {})
  zernio.server.stop(true)
})

describe('acceptance 1 — a brand-new workspace asks the provider nothing until it connects', () => {
  test('listing accounts is empty, with no provider call and no profile created', async () => {
    zernio.state.calls.length = 0
    const res = await syncAccounts(fresh)
    expect(res.status).toBe(200)
    expect((await res.json()).accounts).toEqual([])

    expect(zernio.state.calls).toHaveLength(0)
    expect(await db.socialProfile.count({ where: { workspaceId: fresh } })).toBe(0)
  })
})

describe('acceptance 2 — the first connect creates one profile and returns a sign-in link', () => {
  test('connect answers the provider’s authUrl and stores the `_id` Zernio returned', async () => {
    zernio.state.calls.length = 0
    const res = await connect(fresh)
    expect(res.status).toBe(200)
    const body = await res.json()

    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: fresh, localWorkspaceId: '' } },
    })
    expect(profile).toBeTruthy()
    // The id Zernio returned inside `{ profile: { _id } }`, not a top-level `id`.
    expect(profile.zernioProfileId).toBe(zernio.state.profiles[0]._id)
    expect(profile.externalId).toBe(`ws_${fresh}`)

    expect(body.url).toBe(
      `https://zernio.test/oauth/instagram?profile=${zernio.state.profiles[0]._id}`,
    )
    // The response names our own row; the id the provider is pinned to is the
    // one asserted on the forwarded call below.
    expect(body.profileId).toBe(profile.id)

    const created = zernio.state.calls.filter((call) => call.method === 'POST' && call.path === '/profiles')
    expect(created).toHaveLength(1)
    expect(created[0].body).toEqual({ name: 'SHO202 Fresh', externalId: `ws_${fresh}` })

    const connectCall = zernio.state.calls.find((call) => call.path === '/connect/instagram')
    expect(connectCall?.query.profileId).toBe(profile.zernioProfileId)
  })

  test('a second connect reuses that one profile instead of creating another', async () => {
    zernio.state.calls.length = 0
    const res = await connect(fresh, 'tiktok')
    expect(res.status).toBe(200)

    expect(
      zernio.state.calls.filter((call) => call.method === 'POST' && call.path === '/profiles'),
    ).toHaveLength(0)
    expect(await db.socialProfile.count({ where: { workspaceId: fresh } })).toBe(1)
    const connectCall = zernio.state.calls.find((call) => call.path === '/connect/tiktok')
    expect(connectCall?.query.profileId).toBe(zernio.state.profiles[0]._id)
  })

  test('after the sign-in, sync lists the account without its `@` and keeps it active', async () => {
    const profileId = zernio.state.profiles[0]._id
    zernio.state.accounts.push({
      _id: '66aa11bb22cc33dd44ee55ff',
      platform: 'instagram',
      username: '@acme',
      displayName: 'Acme',
      profileId: { _id: profileId, name: 'SHO202 Fresh' },
      tokenHealthy: true,
      needsReconnect: false,
    })

    const res = await syncAccounts(fresh)
    expect(res.status).toBe(200)
    const accounts = (await res.json()).accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      platform: 'instagram',
      username: 'acme',
      zernioAccountId: '66aa11bb22cc33dd44ee55ff',
      isActive: true,
    })

    // A second sync sees the same provider account and must not deactivate it.
    const again = (await (await syncAccounts(fresh)).json()).accounts
    expect(again).toHaveLength(1)
    expect(again[0].isActive).toBe(true)
  })
})

describe('acceptance 3 — a profile an earlier failed attempt created is adopted, not duplicated', () => {
  test('a 409 names the profile and the first connect still returns a link', async () => {
    // The previous attempt reached Zernio and created the profile, but the row
    // was never written — exactly the state the bug left production in.
    const orphan = {
      _id: '64f0aaaa0000bbbb1111cccc',
      name: 'SHO202 Return',
      externalId: `ws_${alreadyAtZernio}`,
    }
    zernio.state.profiles.push(orphan)
    zernio.state.calls.length = 0

    const res = await connect(alreadyAtZernio)
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe(`https://zernio.test/oauth/instagram?profile=${orphan._id}`)

    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: alreadyAtZernio, localWorkspaceId: '' } },
    })
    expect(profile.zernioProfileId).toBe(orphan._id)
    expect(profile.externalId).toBe(`ws_${alreadyAtZernio}`)
    expect(await db.socialProfile.count({ where: { workspaceId: alreadyAtZernio } })).toBe(1)
    expect(zernio.state.profiles.filter((p) => p.externalId === `ws_${alreadyAtZernio}`)).toHaveLength(1)
  })

  test('the live 409 names no profile, so the exact externalId list is what adopts it', async () => {
    // Same state as above, but with the body the real API sends (no
    // `existingProfileId`, code `invalid_request_error`).
    const orphan = {
      _id: '64f0eeee4444ffff5555aaaa',
      name: 'SHO202 Live Conflict',
      externalId: `ws_${liveConflict}`,
    }
    zernio.state.profiles.push(orphan)
    zernio.state.conflictStyle = 'live'
    zernio.state.calls.length = 0
    try {
      const res = await connect(liveConflict)
      expect(res.status).toBe(200)
      expect((await res.json()).url).toBe(`https://zernio.test/oauth/instagram?profile=${orphan._id}`)
    } finally {
      zernio.state.conflictStyle = 'documented'
    }

    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: liveConflict, localWorkspaceId: '' } },
    })
    expect(profile.zernioProfileId).toBe(orphan._id)
    expect(await db.socialProfile.count({ where: { workspaceId: liveConflict } })).toBe(1)
  })

  test('a list holding another tenant’s profile is never adopted, and the 502 explains why', async () => {
    // Someone else's profile exists; our create is refused outright.
    zernio.state.profiles.push({
      _id: '64f0dddd2222eeee3333ffff',
      name: 'Another tenant',
      externalId: 'ws_somebody_else',
    })
    zernio.state.createFails = {
      status: 422,
      body: { error: 'externalId is not allowed on create', type: 'validation_error' },
    }
    zernio.state.calls.length = 0
    try {
      const res = await connect(anotherTenant)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error.code).toBe('social_profile_unresolved')
      // The create's own rejection has to survive: without it the only thing an
      // operator sees is "Zernio did not return a profile id".
      expect(body.error.create).toMatchObject({
        status: 422,
        code: 'validation_error',
        message: 'externalId is not allowed on create',
      })
      expect(body.error.externalId).toBe(`ws_${anotherTenant}`)
      expect(await db.socialProfile.count({ where: { workspaceId: anotherTenant } })).toBe(0)
    } finally {
      zernio.state.createFails = null
    }
  })
})

describe('acceptance 4 — the desktop relay creates and records a first connect', () => {
  test('a scope with no profile row gets one created, recorded and forwarded', async () => {
    zernio.state.calls.length = 0
    const res = await relay('/connect/instagram', relayed, relayScope)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.authUrl).toContain('https://zernio.test/oauth/instagram')

    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: relayed, localWorkspaceId: relayScope } },
    })
    expect(profile).toBeTruthy()
    expect(profile.externalId).toBe(`lws_${relayScope}`)
    expect(profile.zernioProfileId).toBe(
      zernio.state.profiles.find((p) => p.externalId === `lws_${relayScope}`)._id,
    )

    const connectCall = zernio.state.calls.find((call) => call.path === '/connect/instagram')
    expect(connectCall?.query.profileId).toBe(profile.zernioProfileId)
  })

  test('a second relayed connect forwards with the recorded profile and creates nothing', async () => {
    const recorded = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: relayed, localWorkspaceId: relayScope } },
    })
    zernio.state.calls.length = 0
    const res = await relay('/connect/tiktok', relayed, relayScope)
    expect(res.status).toBe(200)

    expect(
      zernio.state.calls.filter((call) => call.method === 'POST' && call.path === '/profiles'),
    ).toHaveLength(0)
    expect(zernio.state.calls.find((call) => call.path === '/connect/tiktok')?.query.profileId).toBe(
      recorded.zernioProfileId,
    )
  })

  test('the relayed account list records the account the desktop will show', async () => {
    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: relayed, localWorkspaceId: relayScope } },
    })
    zernio.state.accounts.push({
      _id: '66bb22cc33dd44ee55ff66aa',
      platform: 'tiktok',
      username: '@acme.tt',
      profileId: { _id: profile.zernioProfileId },
      tokenHealthy: true,
      needsReconnect: false,
    })

    const res = await relay('/accounts', relayed, relayScope)
    expect(res.status).toBe(200)

    const row = await db.socialAccount.findFirst({
      where: { workspaceId: relayed, zernioAccountId: '66bb22cc33dd44ee55ff66aa' },
    })
    expect(row).toBeTruthy()
    expect(row.username).toBe('acme.tt')
    expect(row.platform).toBe('tiktok')
  })
})
