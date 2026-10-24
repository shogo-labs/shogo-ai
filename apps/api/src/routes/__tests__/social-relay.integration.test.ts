// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 QA round 1, B1 — the cloud relay must not let one workspace's key
 * drive another tenant's Zernio resources. These cases run the real route with
 * a fake provider: the point is what the relay forwards, and what it refuses,
 * not what Zernio answers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRelayRoutes } = await import('../social')
const { setSocialClient, SocialError } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const workspaceId = c.req.header('x-workspace')
  c.set('auth', { workspaceId, isAuthenticated: !!workspaceId } as never)
  await next()
})
app.route('/api', socialRelayRoutes())

const relay = (path: string, workspaceId: string | null, init: RequestInit = {}) =>
  app.request(`/api/social-relay${path}`, {
    ...init,
    headers: {
      ...(workspaceId ? { 'x-workspace': workspaceId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let own = ''
let other = ''
const calls: any[] = []

beforeAll(async () => {
  const [ownWs, otherWs] = await Promise.all([
    db.workspace.create({ data: { name: 'Own', slug: `own-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Other', slug: `other-${suffix}`, kind: 'team' } }),
  ])
  own = ownWs.id
  other = otherWs.id

  await db.socialProfile.create({
    data: { workspaceId: own, zernioProfileId: 'zernio_own', externalId: own, name: 'Own' },
  })
  await db.socialProfile.create({
    data: { workspaceId: other, zernioProfileId: 'zernio_other', externalId: other, name: 'Other' },
  })
  await db.socialAccount.create({
    data: {
      workspaceId: own,
      profileId: (await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: own, localWorkspaceId: '' } } })).id,
      zernioAccountId: 'acct_own',
      platform: 'instagram',
      username: 'own.ig',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId: other,
      profileId: (await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: other, localWorkspaceId: '' } } })).id,
      zernioAccountId: 'acct_other',
      platform: 'instagram',
      username: 'other.ig',
    },
  })

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles' && req.method === 'POST') {
        return { id: 'zernio_created', externalId: req.body.externalId }
      }
      if (req.path === '/accounts') {
        return { accounts: [{ id: 'acct_own', platform: 'instagram', username: 'own.ig' }] }
      }
      if (req.path === '/posts' && req.method === 'POST') {
        return { id: 'zernio_post_new', targets: [] }
      }
      return {}
    },
  })
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.deleteMany({ where: { id: { in: [own, other] } } }).catch(() => {})
})

describe('relay tenant scoping', () => {
  test('a request without a resolved workspace is refused', async () => {
    const res = await relay('/profiles', null)
    expect(res.status).toBe(401)
  })

  test('listing profiles only ever asks for the caller’s external id', async () => {
    calls.length = 0
    const res = await relay('/profiles?externalId=victim', own)
    expect(res.status).toBe(200)
    expect(calls[0].query).toEqual({ externalId: `ws_${own}` })
  })

  test('creating a profile forces the caller’s external id and records the mapping', async () => {
    calls.length = 0
    const res = await relay('/profiles', own, {
      method: 'POST',
      body: JSON.stringify({ name: 'Hijack', externalId: other }),
    })
    expect(res.status).toBe(200)
    expect(calls[0].body.externalId).toBe(`ws_${own}`)

    const created = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: own, localWorkspaceId: '' } } })
    expect(created.zernioProfileId).toBe('zernio_created')
  })

  test('another workspace’s account cannot be deleted through the relay', async () => {
    calls.length = 0
    const res = await relay('/accounts/acct_other', own, { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('account_out_of_scope')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  test('the caller’s own account still deletes', async () => {
    calls.length = 0
    const res = await relay('/accounts/acct_own', own, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/accounts/acct_own')
  })

  test('publishing is pinned to the caller’s profile even when the body lies', async () => {
    calls.length = 0
    const res = await relay('/posts', own, {
      method: 'POST',
      body: JSON.stringify({ content: 'mine', profileId: 'zernio_other', platforms: [] }),
    })
    expect(res.status).toBe(200)
    const profile = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: own, localWorkspaceId: '' } } })
    expect(calls[0].body.profileId).toBe(profile.zernioProfileId)
    expect(calls[0].body.profileId).not.toBe('zernio_other')
  })

  test('an unknown post id is refused before the provider sees it', async () => {
    calls.length = 0
    const res = await relay('/posts/zernio_post_unknown', own, {
      method: 'PATCH',
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('post_out_of_scope')
    expect(calls).toHaveLength(0)
  })

  test('a post this workspace created can be rescheduled', async () => {
    // Created through the relay above, so the cloud recorded its ownership.
    expect(
      await db.socialPost.findFirst({ where: { workspaceId: own, zernioPostId: 'zernio_post_new' } }),
    ).toBeTruthy()
    calls.length = 0
    const res = await relay('/posts/zernio_post_new', own, {
      method: 'PATCH',
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
    })
    expect(res.status).toBe(200)
    expect(calls.find((call) => call.method === 'PATCH')?.path).toBe('/posts/zernio_post_new')
  })

  test('paths outside the allowlist never reach the provider', async () => {
    calls.length = 0
    const res = await relay('/analytics', own, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('relay_path_not_allowed')
    expect(calls).toHaveLength(0)
  })

  test('an automation create with no account never reaches the provider', async () => {
    calls.length = 0
    const res = await relay('/comment-automations', own, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_body')
    expect(calls).toHaveLength(0)
  })

  test('a provider failure keeps the API error shape', async () => {
    setSocialClient({
      mode: 'cloud',
      async request() {
        throw new SocialError(400, 'rate_limited', 'Instagram rate limited', { platform: 'instagram' })
      },
    })
    const res = await relay('/accounts', own)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.message).toBe('Instagram rate limited')
    expect(body.error.platform).toBe('instagram')
  })

  test('a dead-lettered delivery can be replayed, by its own workspace only', async () => {
    const { enqueueRelayedEvent, failRelayedEvents, MAX_ATTEMPTS, listDeadLettered } = await import(
      '../../services/social/relay-events.service'
    )

    // Two dead letters, one per tenant.
    const mine = await enqueueRelayedEvent({
      workspaceId: own,
      envelope: {
        externalId: `lws_${suffix}`,
        localWorkspaceId: suffix,
        eventId: `evt_replay_${suffix}`,
        type: 'comment.received',
        occurredAt: new Date().toISOString(),
      },
    })
    const theirs = await enqueueRelayedEvent({
      workspaceId: other,
      envelope: {
        externalId: `lws_other_${suffix}`,
        localWorkspaceId: `${suffix}-other`,
        eventId: `evt_other_${suffix}`,
        type: 'comment.received',
        occurredAt: new Date().toISOString(),
      },
    })
    for (const [workspaceId, id] of [
      [own, mine.id],
      [other, theirs.id],
    ] as const) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await failRelayedEvents({ workspaceId, failures: [{ id, error: 'catalog rejected it' }] })
      }
    }
    expect((await listDeadLettered({ workspaceId: own })).map((row: any) => row.id)).toEqual([mine.id])

    // A foreign id changes nothing: the replay is scoped by the caller's key.
    const foreign = await relay('/events/replay', own, {
      method: 'POST',
      body: JSON.stringify({ ids: [theirs.id] }),
    })
    expect(foreign.status).toBe(200)
    expect((await foreign.json()).requeued).toBe(0)

    const replay = await relay('/events/replay', own, {
      method: 'POST',
      body: JSON.stringify({ ids: [mine.id] }),
    })
    expect(replay.status).toBe(200)
    expect((await replay.json()).requeued).toBe(1)

    // Back in the poll, so the desktop can apply and ack it this time.
    const pending = await relay('/events', own)
    const events = (await pending.json()).events
    expect(events.map((event: any) => event.id)).toEqual([mine.id])

    // And the other tenant's row is untouched.
    expect((await listDeadLettered({ workspaceId: other })).map((row: any) => row.id)).toEqual([theirs.id])
  })
})

/**
 * The cases above trust the middleware to have put a workspace on the context.
 * These two run the chain production actually mounts — `authMiddleware` →
 * `apiAuthGate` → relay — with real `shogo_sk_*` keys, because a workspace id
 * that never reaches the route is the one failure a stubbed context cannot see.
 */
describe('relay through the real auth chain (AC7)', () => {
  let chainApp: Hono
  const outbound: { url: string; headers: Record<string, string> }[] = []
  const providerCalls: { url: string; headers: Record<string, string> }[] = []
  const originalFetch = globalThis.fetch
  const savedEnv = {
    SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
    SHOGO_API_KEY: process.env.SHOGO_API_KEY,
    ZERNIO_API_KEY: process.env.ZERNIO_API_KEY,
    SOCIAL_MODE: process.env.SOCIAL_MODE,
  }
  let ownKey = ''
  let otherKey = ''

  beforeAll(async () => {
    const { authMiddleware } = await import('../../middleware/auth')
    const { apiAuthGate } = await import('../../middleware/api-auth-gate')
    const { socialRoutes } = await import('../social')
    const { hashApiKey } = await import('../../lib/api-keys-mint')

    chainApp = new Hono()
    chainApp.use('/api/*', authMiddleware)
    chainApp.use('/api/*', apiAuthGate)
    chainApp.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))
    chainApp.route('/api', socialRelayRoutes())

    for (const [workspaceId, label] of [[own, 'own'], [other, 'other']] as const) {
      const user = await db.user.create({
        data: { name: `relay-${label}`, email: `relay-${label}-${suffix}@example.com` },
      })
      await db.member.create({ data: { workspaceId, userId: user.id, role: 'owner', projectId: null } })
      const raw = `shogo_sk_${crypto.randomUUID().replace(/-/g, '')}`
      await db.apiKey.create({
        data: {
          name: `relay-${label}`,
          keyHash: await hashApiKey(raw),
          keyPrefix: raw.slice(0, 16),
          workspaceId,
          userId: user.id,
          kind: 'user',
        },
      })
      if (label === 'own') ownKey = raw
      else otherKey = raw
    }
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete (process.env as any)[key]
      else (process.env as any)[key] = value
    }
  })

  test('a real workspace key resolves the workspace the relay scopes against', async () => {
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        calls.push(req)
        return { accounts: [{ id: 'acct_own', platform: 'instagram', username: 'own.ig' }] }
      },
    })
    calls.length = 0
    const res = await chainApp.request('/api/social-relay/accounts', {
      headers: { authorization: `Bearer ${ownKey}` },
    })
    expect(res.status).toBe(200)
    const ownProfile = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: own, localWorkspaceId: '' } } })
    expect(calls[0].query).toEqual({ profileId: ownProfile.zernioProfileId })

    // And the other tenant's key is scoped to its own profile, not this one.
    calls.length = 0
    await chainApp.request('/api/social-relay/accounts', {
      headers: { authorization: `Bearer ${otherKey}` },
    })
    const otherProfile = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: other, localWorkspaceId: '' } } })
    expect(calls[0].query.profileId).not.toBe(ownProfile.zernioProfileId)
    expect(calls[0].query.profileId).toBe(otherProfile.zernioProfileId)
  })

  test('a desktop forwards every social call and the master key never leaves the cloud', async () => {
    // A desktop: local mode + its own workspace key, no master Zernio key.
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = ownKey
    process.env.ZERNIO_API_KEY = 'zernio_master_must_not_reach_the_desktop'
    delete process.env.SOCIAL_MODE
    setSocialClient(null)

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = new URL(String(input))
      const headers = (init.headers ?? {}) as Record<string, string>
      if (url.pathname.startsWith('/api/social-relay')) {
        outbound.push({ url: String(input), headers })
        // The hop lands on the cloud process, which is not in local mode.
        process.env.SHOGO_LOCAL_MODE = 'false'
        delete process.env.SHOGO_API_KEY
        try {
          return await chainApp.request(url.pathname + url.search, {
            method: init.method,
            headers,
            body: init.body,
          })
        } finally {
          process.env.SHOGO_LOCAL_MODE = 'true'
          process.env.SHOGO_API_KEY = ownKey
        }
      }
      providerCalls.push({ url: String(input), headers })
      return new Response(
        JSON.stringify({ accounts: [{ id: 'acct_own', platform: 'instagram', username: 'own.ig' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as any

    const { getSocialClient } = await import('../../services/social/client')
    const client = getSocialClient()
    expect(client.mode).toBe('relay')

    outbound.length = 0
    providerCalls.length = 0
    const result = await client.request<any>({ method: 'GET', path: '/accounts' })
    expect(result).toHaveProperty('accounts')

    expect(outbound).toHaveLength(1)
    expect(outbound[0].url).toContain('/api/social-relay/accounts')
    expect(outbound[0].headers.Authorization).toBe(`Bearer ${ownKey}`)
    // The relay, not the desktop, put the master key on the provider call.
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].url).toStartWith('https://zernio.com/api/v1/accounts')
    expect(providerCalls[0].headers.Authorization).toBe('Bearer zernio_master_must_not_reach_the_desktop')
    expect(outbound[0].url).not.toContain('zernio_master_must_not_reach_the_desktop')
  })
})
