// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P3 — §3a scoping and the Zernio webhook ingress.
 *
 * Two things are proved here against a real SQLite DB (migrations replayed)
 * and a fake provider: a desktop's second local workspace gets its own profile
 * instead of colliding on the unique columns, and a signed webhook is routed to
 * the scope its `externalId` names — emitted in place for the cloud scope,
 * relayed to the desktop for a local one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

process.env.ZERNIO_WEBHOOK_SECRET = 'whsec_sho71'

const { prisma } = await import('../../lib/prisma')
const { socialRelayRoutes, socialEventRoutes, socialWebhookRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')
const { getSyncEngine } = await import('../../lib/sync-engine')
const { drainRelayedEvents } = await import('../../services/social/relay-consumer')

const db = prisma as any

/** A signed request through the relay route, scoped to `workspaceId` + `localScope`. */
const app = new Hono()
app.use('*', async (c, next) => {
  const workspaceId = c.req.header('x-workspace')
  c.set('auth', { workspaceId, isAuthenticated: !!workspaceId } as never)
  await next()
})
app.route('/api', socialRelayRoutes())
app.route('/api', socialWebhookRoutes())
app.route(
  '/api',
  socialEventRoutes({ authorize: async (c) => (c.req.header('x-runtime-token') === 'rt_ok' ? {} : null) }),
)

const relay = (path: string, workspaceId: string, localScope: string | null, init: RequestInit = {}) =>
  app.request(`/api/social-relay${path}`, {
    ...init,
    headers: {
      'x-workspace': workspaceId,
      ...(localScope ? { 'x-shogo-local-workspace': localScope } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let cloudWorkspace = ''
let desktopLocalA = ''
let desktopLocalB = ''
let zernioProfileSeq = 0
const calls: any[] = []

const signedHook = (body: string, eventId: string, secret = 'whsec_sho71') =>
  app.request('/api/webhooks/zernio', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-zernio-event-id': eventId,
      'x-zernio-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
  })

const zernioEvent = (externalId: string, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    profiles: [{ id: 'zp', externalId }],
    account: { id: 'acc_hook', platform: 'instagram', username: 'hook.ig' },
    ...extra,
  })

beforeAll(async () => {
  const [cloud, localA, localB] = await Promise.all([
    db.workspace.create({ data: { name: 'Cloud', slug: `cloud-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Local A', slug: `local-a-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Local B', slug: `local-b-${suffix}`, kind: 'team' } }),
  ])
  cloudWorkspace = cloud.id
  desktopLocalA = localA.id
  desktopLocalB = localB.id

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.method === 'POST' && req.path === '/profiles') {
        return { id: `zernio_created_${++zernioProfileSeq}`, externalId: req.body.externalId }
      }
      return { id: 'zernio_created', ...req.body }
    },
  })
})

afterAll(() => {
  setSocialClient(null)
})

describe('§3a — one Zernio profile per local workspace', () => {
  test('a second local workspace gets its own profile instead of a constraint error', async () => {
    calls.length = 0
    const first = await relay('/profiles', cloudWorkspace, desktopLocalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local A' }),
    })
    expect(first.status).toBe(200)
    expect(calls[0].body.externalId).toBe(`lws_${desktopLocalA}`)

    const second = await relay('/profiles', cloudWorkspace, desktopLocalB, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local B' }),
    })
    expect(second.status).toBe(200)
    expect(calls[1].body.externalId).toBe(`lws_${desktopLocalB}`)

    const rows = await db.socialProfile.findMany({ where: { workspaceId: cloudWorkspace } })
    expect(rows.map((row: any) => row.localWorkspaceId).sort()).toEqual([desktopLocalA, desktopLocalB].sort())
    expect(rows.map((row: any) => row.externalId).sort()).toEqual(
      [`lws_${desktopLocalA}`, `lws_${desktopLocalB}`].sort(),
    )
    expect(new Set(rows.map((row: any) => row.zernioProfileId)).size).toBe(2)
  })

  test('the same local scope re-connects to the same row and the same routing id', async () => {
    const before = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
    })
    const again = await relay('/profiles', cloudWorkspace, desktopLocalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local A again' }),
    })
    expect(again.status).toBe(200)
    const after = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
    })
    expect(after.id).toBe(before.id)
    expect(after.externalId).toBe(`lws_${desktopLocalA}`)
    expect(await db.socialProfile.count({ where: { workspaceId: cloudWorkspace } })).toBe(2)
  })

  test('a read is pinned to the caller’s own scope, never the cloud one', async () => {
    calls.length = 0
    const res = await relay('/profiles', cloudWorkspace, desktopLocalB)
    expect(res.status).toBe(200)
    expect(calls[0].query).toEqual({ externalId: `lws_${desktopLocalB}` })
  })

  test('a rename changes the name, never the routing id', async () => {
    const { renameProfile } = await import('../../services/social/profiles.service')
    const where = { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA }
    const before = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: where } })

    await renameProfile(cloudWorkspace, 'Renamed A')

    const after = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: where } })
    expect(after.name).toBe('Renamed A')
    expect(after.externalId).toBe(before.externalId)
    expect(after.zernioProfileId).toBe(before.zernioProfileId)
  })

  test('a local scope that is not a workspace id is refused before any provider call', async () => {
    calls.length = 0
    const res = await relay('/profiles', cloudWorkspace, 'not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_local_workspace')
    expect(calls.length).toBe(0)
  })
})

describe('webhook ingress', () => {
  beforeAll(async () => {
    await db.socialProfile.create({
      data: {
        workspaceId: cloudWorkspace,
        localWorkspaceId: '',
        zernioProfileId: 'zernio_cloud_scope',
        externalId: `ws_${cloudWorkspace}`,
        name: 'Cloud',
      },
    })
    await db.socialAccount.create({
      data: {
        workspaceId: cloudWorkspace,
        profileId: (
          await db.socialProfile.findUnique({
            where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: '' } },
          })
        ).id,
        zernioAccountId: 'acc_hook',
        platform: 'instagram',
        username: 'hook.ig',
      },
    })
  })

  test('an unsigned or wrongly signed delivery is rejected', async () => {
    const body = zernioEvent(`ws_${cloudWorkspace}`, 'comment.received')
    const unsigned = await app.request('/api/webhooks/zernio', { method: 'POST', body })
    expect(unsigned.status).toBe(401)
    const wrong = await signedHook(body, 'evt_bad', 'not-the-secret')
    expect(wrong.status).toBe(401)
  })

  test('a cloud-scope comment is emitted as social.comment.received, once per event id', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const body = zernioEvent(`ws_${cloudWorkspace}`, 'comment.received', {
      comment: { id: 'cmt_1', text: 'MERGE' },
    })

    const first = await signedHook(body, eventId)
    expect(first.status).toBe(200)
    expect((await first.json()).type).toBe('social.comment.received')

    const emitted = await db.workspaceEvent.findUnique({
      where: { workspaceId_dedupeKey: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` } },
    })
    expect(emitted.type).toBe('social.comment.received')
    expect(emitted.source).toBe('zernio')
    expect(emitted.payload.externalId).toBe(`ws_${cloudWorkspace}`)
    expect(emitted.payload.comment).toEqual({ id: 'cmt_1', text: 'MERGE' })

    // Zernio retries 7×: the same event id must not fan out twice.
    const replay = await signedHook(body, eventId)
    expect(replay.status).toBe(200)
    expect((await replay.json()).duplicate).toBe(true)
    expect(
      await db.workspaceEvent.count({
        where: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` },
      }),
    ).toBe(1)
  })

  test('account.disconnected flips the account to needs-reconnect', async () => {
    const res = await signedHook(
      zernioEvent(`ws_${cloudWorkspace}`, 'account.disconnected'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)
    const row = await db.socialAccount.findUnique({ where: { zernioAccountId: 'acc_hook' } })
    expect(row.needsReconnect).toBe(true)
    expect(row.isActive).toBe(false)
  })

  test('a local-scope event is relayed to that desktop and writes nothing in the cloud', async () => {
    const externalId = `lws_${desktopLocalA}`
    const eventId = `evt_${crypto.randomUUID()}`
    const seen: any[] = []
    const unsubscribe = getSyncEngine().subscribe('test-desktop', cloudWorkspace, 'desktop', (event) => {
      seen.push(event)
    })

    const res = await signedHook(
      zernioEvent(externalId, 'message.received', { message: { id: 'msg_1', text: 'hi' } }),
      eventId,
    )
    unsubscribe()

    expect(res.status).toBe(200)
    expect((await res.json()).relayed).toBe(desktopLocalA)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('SOCIAL_EVENT')
    expect(seen[0].payload.localWorkspaceId).toBe(desktopLocalA)
    expect(seen[0].payload.eventId).toBe(eventId)

    // The cloud owns no rows for a local scope: it cannot apply what it does not store.
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(0)

    // ...but the delivery is written down before the provider got its 200, so a
    // desktop that was offline still receives it.
    const row = await db.socialRelayedEvent.findUnique({ where: { dedupeKey: `zernio:${eventId}` } })
    expect(row.localWorkspaceId).toBe(desktopLocalA)
    expect(row.appliedAt).toBeNull()
    expect(JSON.parse(row.eventJson).type).toBe('message.received')
  })

  test('a provider retry of a relayed event collapses onto the recorded delivery', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const body = zernioEvent(`lws_${desktopLocalB}`, 'comment.received', { comment: { id: 'cmt_r' } })

    expect((await signedHook(body, eventId)).status).toBe(200)
    const retry = await signedHook(body, eventId)
    expect(retry.status).toBe(200)

    expect(
      await db.socialRelayedEvent.count({ where: { dedupeKey: `zernio:${eventId}` } }),
    ).toBe(1)
  })

  test('an account.disconnected for a local scope still flips the cloud account row', async () => {
    const localProfile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
    })
    await db.socialAccount.create({
      data: {
        workspaceId: cloudWorkspace,
        profileId: localProfile.id,
        zernioAccountId: 'acc_local_hook',
        platform: 'tiktok',
        username: 'local.tok',
      },
    })

    const res = await signedHook(
      JSON.stringify({
        type: 'account.disconnected',
        profiles: [{ id: 'zp', externalId: `lws_${desktopLocalA}` }],
        account: { id: 'acc_local_hook', platform: 'tiktok', username: 'local.tok' },
      }),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)

    // The relay recorded these accounts cloud-side on sync, so leaving the row
    // healthy would keep billing an account the user removed.
    const row = await db.socialAccount.findUnique({ where: { zernioAccountId: 'acc_local_hook' } })
    expect(row.isActive).toBe(false)
    expect(row.needsReconnect).toBe(true)
  })

  test('the desktop applies the relayed payload idempotently, in its own DB', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const body = JSON.stringify({
      workspaceId: desktopLocalA,
      localWorkspaceId: desktopLocalA,
      externalId: `lws_${desktopLocalA}`,
      eventId,
      type: 'comment.received',
      account: { zernioAccountId: 'acc_local', platform: 'instagram', username: 'local.ig' },
      detail: { id: 'cmt_9', text: 'MERGED' },
    })
    const post = (token: string | null) =>
      app.request('/api/social/events', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-runtime-token': token } : {}),
        },
      })

    expect((await post(null)).status).toBe(401)

    const first = await post('rt_ok')
    expect(first.status).toBe(200)
    expect((await first.json()).type).toBe('social.comment.received')

    const second = await post('rt_ok')
    expect((await second.json()).duplicate).toBe(true)
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: desktopLocalA, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(1)
  })

  test('an unknown profile is accepted and dropped, never a 404 the provider would retry', async () => {
    const res = await signedHook(
      zernioEvent(`ws_${crypto.randomUUID()}`, 'comment.received'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('unknown_profile')
  })

  test('a malformed local routing id is a 400 and writes nothing', async () => {
    const res = await signedHook(
      zernioEvent('lws_not-a-uuid', 'comment.received'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_local_workspace')
  })
})

describe('relayed delivery: poll and ack', () => {
  let otherTenant = ''
  let otherEventId = ''

  beforeAll(async () => {
    const other = await db.workspace.create({
      data: { name: 'Other tenant', slug: `other-${suffix}`, kind: 'team' },
    })
    otherTenant = other.id
    otherEventId = `evt_${crypto.randomUUID()}`
    await db.socialRelayedEvent.create({
      data: {
        dedupeKey: `zernio:${otherEventId}`,
        workspaceId: otherTenant,
        localWorkspaceId: crypto.randomUUID(),
        externalId: 'lws_other',
        eventType: 'comment.received',
        eventJson: JSON.stringify({ type: 'comment.received' }),
      },
    })
  })

  test('a desktop polls only its own workspace’s undelivered events', async () => {
    const res = await relay('/events', cloudWorkspace, null)
    expect(res.status).toBe(200)
    const { events } = await res.json()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event: any) => event.workspaceId === cloudWorkspace)).toBe(true)
    expect(events.map((event: any) => event.id)).not.toContain(
      (await db.socialRelayedEvent.findUnique({ where: { dedupeKey: `zernio:${otherEventId}` } })).id,
    )
    expect(events[0]).toMatchObject({ externalId: expect.any(String), eventId: expect.any(String) })
  })

  test('another tenant’s ids cannot be acked, and its events stay undelivered', async () => {
    const foreign = await db.socialRelayedEvent.findUnique({
      where: { dedupeKey: `zernio:${otherEventId}` },
    })
    const res = await relay('/events/ack', cloudWorkspace, null, {
      method: 'POST',
      body: JSON.stringify({ ids: [foreign.id] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).acked).toBe(0)
    expect(
      (await db.socialRelayedEvent.findUnique({ where: { id: foreign.id } })).appliedAt,
    ).toBeNull()
  })

  test('an ack marks the delivery applied, so it is not polled again', async () => {
    const pending = await (await relay('/events', cloudWorkspace, null)).json()
    const first = pending.events[0]

    const ack = await relay('/events/ack', cloudWorkspace, null, {
      method: 'POST',
      body: JSON.stringify({ ids: [first.id] }),
    })
    expect((await ack.json()).acked).toBe(1)

    const after = await (await relay('/events', cloudWorkspace, null)).json()
    expect(after.events.map((event: any) => event.id)).not.toContain(first.id)
    expect(
      (await db.socialRelayedEvent.findUnique({ where: { id: first.id } })).appliedAt,
    ).not.toBeNull()
  })

  test('an event for a profile we do not own is never queued', async () => {
    const before = await db.socialRelayedEvent.count()
    const res = await signedHook(
      zernioEvent(`ws_${crypto.randomUUID()}`, 'comment.received'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('unknown_profile')
    expect(await db.socialRelayedEvent.count()).toBe(before)
  })
})

/**
 * QA acceptance (SHO-71 AC7, desktop half): the whole delivery chain, with the
 * real consumer driving the real routes and the real apply handler. The cloud
 * side is a signed provider webhook; the desktop side is `drainRelayedEvents`
 * with only the transport injected, so a route, ack or dedupe bug shows up as
 * a missing or doubled row rather than a passing stub.
 */
describe('relayed delivery: the desktop consumer, end to end', () => {
  // Earlier cases queue deliveries for these two scopes and never poll them;
  // close them out so an exact count here means what it says.
  beforeAll(async () => {
    await db.socialRelayedEvent.updateMany({
      where: { localWorkspaceId: { in: [desktopLocalA, desktopLocalB] }, appliedAt: null },
      data: { appliedAt: new Date() },
    })
  })

  /** The consumer's `fetch` is the app itself: real routes, real headers. */
  const relayFetch = (async (url: string, init: any = {}) => {
    const parsed = new URL(String(url))
    return app.request(`${parsed.pathname}${parsed.search}`, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: { ...(init.headers ?? {}), 'x-workspace': cloudWorkspace },
    })
  }) as unknown as typeof fetch

  const relayConfig = () => ({
    mode: 'relay' as const,
    baseUrl: 'http://relay.test/api/social-relay',
    apiKey: 'shogo_sk_qa',
  })

  const drainDesktopA = () =>
    drainRelayedEvents({
      fetchImpl: relayFetch,
      resolveConfig: relayConfig,
      localScopes: async () => [desktopLocalA],
    })

  test('a signed webhook reaches the desktop\'s own DB exactly once', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const hook = await signedHook(
      zernioEvent(`lws_${desktopLocalA}`, 'comment.received', {
        comment: { id: 'cmt_qa_1', text: 'MERGE please' },
      }),
      eventId,
    )
    expect(hook.status).toBe(200)
    // The cloud applied nothing: a local scope has no cloud rows.
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(0)

    const first = await drainDesktopA()
    expect(first).toMatchObject({ fetched: 1, applied: 1, acked: 1 })

    const applied = await db.workspaceEvent.findMany({
      where: { workspaceId: desktopLocalA, dedupeKey: `zernio:${eventId}` },
    })
    expect(applied).toHaveLength(1)
    expect(applied[0].type).toBe('social.comment.received')

    // Acked, so the next poll has nothing to hand over.
    expect(await drainDesktopA()).toMatchObject({ fetched: 0, applied: 0, acked: 0 })
  })

  test('a delivery whose ack was lost is re-applied without duplicating the event', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    expect(
      (
        await signedHook(
          zernioEvent(`lws_${desktopLocalA}`, 'message.received', {
            message: { id: 'msg_qa_1', text: 'sent from the provider' },
          }),
          eventId,
        )
      ).status,
    ).toBe(200)
    expect((await drainDesktopA()).applied).toBe(1)

    // The desktop applied it but never got to say so (network died mid-ack).
    await db.socialRelayedEvent.updateMany({
      where: { dedupeKey: `zernio:${eventId}` },
      data: { appliedAt: null },
    })

    const second = await drainDesktopA()
    expect(second).toMatchObject({ fetched: 1, applied: 1, acked: 1 })
    // Same outbox dedupe key, so the workspace still sees one event.
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: desktopLocalA, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(1)
  })

  test('a disconnect flips the cloud row *and* still reaches the desktop', async () => {
    const profile = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalB } },
    })
    await db.socialAccount.create({
      data: {
        workspaceId: cloudWorkspace,
        profileId: profile.id,
        zernioAccountId: 'acc_qa_disconnect',
        platform: 'instagram',
        username: 'qa.ig',
      },
    })
    const eventId = `evt_${crypto.randomUUID()}`

    const res = await signedHook(
      JSON.stringify({
        type: 'account.disconnected',
        profiles: [{ id: 'zp', externalId: `lws_${desktopLocalB}` }],
        account: { id: 'acc_qa_disconnect', platform: 'instagram', username: 'qa.ig' },
      }),
      eventId,
    )
    expect(res.status).toBe(200)

    // The meter bills the cloud's copy, so it must not stay healthy...
    const cloudRow = await db.socialAccount.findUnique({ where: { zernioAccountId: 'acc_qa_disconnect' } })
    expect(cloudRow.isActive).toBe(false)
    // ...and the desktop must still be told, in its own DB.
    const delivered = await drainRelayedEvents({
      fetchImpl: relayFetch,
      resolveConfig: relayConfig,
      localScopes: async () => [desktopLocalB],
    })
    expect(delivered).toMatchObject({ fetched: 1, applied: 1 })
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: desktopLocalB, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(1)
  })
})

/**
 * QA acceptance (SHO-71 AC3/AC7, P4): a DM for a local scope has to reach the
 * desktop's *inbox*, not just its event outbox — and exactly once, because the
 * unread badge is a counter incremented on insert. The dev's inbox tests cover
 * the cloud's own scope and the consumer's happy path separately; this runs the
 * whole chain for one local thread.
 */
describe('relayed delivery: a local-scope DM lands in the desktop inbox once', () => {
  const sinkAccountId = `acc_qa_inbox_${suffix}`
  const providerConversationId = `conv_qa_${suffix}`
  const providerMessageId = `msg_qa_${suffix}`
  const eventId = `evt_qa_inbox_${suffix}`

  const relayFetch = (async (url: string, init: any = {}) => {
    const parsed = new URL(String(url))
    return app.request(`${parsed.pathname}${parsed.search}`, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: { ...(init.headers ?? {}), 'x-workspace': cloudWorkspace },
    })
  }) as unknown as typeof fetch

  const drain = () =>
    drainRelayedEvents({
      fetchImpl: relayFetch,
      resolveConfig: () => ({ mode: 'relay' as const, baseUrl: 'http://relay.test/api/social-relay', apiKey: 'shogo_sk_qa' }),
      localScopes: async () => [desktopLocalA],
    })

  beforeAll(async () => {
    await db.socialAccount.create({
      data: {
        workspaceId: desktopLocalA,
        profileId: (
          await db.socialProfile.findUnique({
            where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
          })
        ).id,
        zernioAccountId: sinkAccountId,
        platform: 'instagram',
        username: 'inbox.ig',
      },
    })
    // Earlier cases queue deliveries for this scope; close them out so the
    // counters below mean what they say.
    await db.socialRelayedEvent.updateMany({
      where: { localWorkspaceId: desktopLocalA, appliedAt: null },
      data: { appliedAt: new Date() },
    })

    const res = await signedHook(
      JSON.stringify({
        type: 'message.received',
        profiles: [{ id: 'zp', externalId: `lws_${desktopLocalA}` }],
        account: { id: sinkAccountId, platform: 'instagram', username: 'inbox.ig' },
        conversation: { id: providerConversationId, platform: 'instagram', status: 'active' },
        message: {
          id: providerMessageId,
          conversationId: providerConversationId,
          platform: 'instagram',
          direction: 'incoming',
          text: 'Do you ship to Portugal?',
          sender: { id: 'psid_qa', name: 'Nadia' },
          createdAt: '2026-10-19T23:00:00.000Z',
        },
      }),
      eventId,
    )
    expect(res.status).toBe(200)
    expect(await drain()).toMatchObject({ fetched: 1, applied: 1, acked: 1 })
  })

  test('the thread and its message are in the desktop\'s own inbox, with one unread', async () => {
    const conversation = await db.socialConversation.findUnique({
      where: { zernioConversationId: providerConversationId },
    })
    expect(conversation?.workspaceId).toBe(desktopLocalA)
    expect(conversation?.unreadCount).toBe(1)
    expect(conversation?.participantName).toBe('Nadia')

    const messages = await db.socialMessage.findMany({ where: { conversationId: conversation.id } })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ direction: 'incoming', text: 'Do you ship to Portugal?' })
    // ...and the account it arrived on is the one we can answer from.
    expect(conversation?.accountId).toBeString()
  })

  test('the cloud inbox stays empty — a local thread is not the cloud\'s business', async () => {
    expect(
      await db.socialConversation.count({ where: { workspaceId: cloudWorkspace, zernioConversationId: providerConversationId } }),
    ).toBe(0)
    expect(
      await db.socialMessage.count({ where: { workspaceId: cloudWorkspace, zernioMessageId: providerMessageId } }),
    ).toBe(0)
  })

  test('redelivery (a lost ack) does not double the message or the badge', async () => {
    await db.socialRelayedEvent.updateMany({ where: { dedupeKey: `zernio:${eventId}` }, data: { appliedAt: null } })
    expect((await drain()).applied).toBe(1)

    const conversation = await db.socialConversation.findUnique({
      where: { zernioConversationId: providerConversationId },
    })
    expect(await db.socialMessage.count({ where: { conversationId: conversation.id } })).toBe(1)
    expect(conversation.unreadCount).toBe(1)
  })
})

/**
 * Automation runs arrive as provider events, not as a poll: the same signed
 * ingress that carries a comment carries the run that an automation did or did
 * not complete, and the run row is what analytics counts.
 */
describe('an automation run lands on the row the relay recorded', () => {
  const resourceId = `wf_${suffix}`
  const executionId = `exec_${suffix}`
  let automationId = ''

  beforeAll(async () => {
    // The cloud scope already has exactly one profile (one workspace, one brand),
    // so reuse it rather than trying to insert a second.
    const profile =
      (await db.socialProfile.findFirst({
        where: { workspaceId: cloudWorkspace, localWorkspaceId: '' },
      })) ??
      (await db.socialProfile.create({
        data: {
          workspaceId: cloudWorkspace,
          localWorkspaceId: '',
          zernioProfileId: `zp_runs_${suffix}`,
          externalId: `ws_${cloudWorkspace}`,
          name: 'Runs',
        },
      }))
    const account = await db.socialAccount.create({
      data: {
        workspaceId: cloudWorkspace,
        profileId: profile.id,
        zernioAccountId: `zacc_runs_${suffix}`,
        platform: 'instagram',
        username: `runs_${suffix}`,
        isActive: true,
      },
    })
    const automation = await db.socialAutomation.create({
      data: {
        workspaceId: cloudWorkspace,
        accountId: account.id,
        kind: 'sequence',
        zernioResourceId: resourceId,
        platform: 'instagram',
        name: 'Merge funnel',
        mode: 'static',
        status: 'active',
        keywords: ['merge'],
      },
    })
    automationId = automation.id
  })

  const runEvent = () =>
    zernioEvent(`ws_${cloudWorkspace}`, 'workflow.run.completed', {
      run: { executionId, workflowId: resourceId, status: 'completed' },
    })

  test('a completed run is counted once, and a redelivery does not count it again', async () => {
    await signedHook(runEvent(), `evt_run_${suffix}`)
    await signedHook(runEvent(), `evt_run_${suffix}`)

    expect(await db.socialAutomationRun.count({ where: { workspaceId: cloudWorkspace, automationId } })).toBe(1)
    const automation = await db.socialAutomation.findUnique({ where: { id: automationId } })
    expect(automation.runCount).toBe(1)
    expect(automation.lastRunAt).not.toBeNull()
  })
})
