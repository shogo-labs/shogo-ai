// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/sync.ts — the catch-up + publish HTTP endpoints
 * for the real-time sync system. Mocks prisma and the sync-engine
 * singleton so tests don't share state.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── prisma mock ───────────────────────────────────────────────────────────

const findFirstMember = mock(async (_: any): Promise<any> => null)

mock.module('../lib/prisma', () => ({
  prisma: {
    member: { findFirst: findFirstMember },
  },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── sync-engine mock ──────────────────────────────────────────────────────

const replayEventsMock = mock((_: any) => ({ events: [], cursor: null, hasMore: false }))
const publishMock = mock((_: any) => {})

mock.module('../lib/sync-engine', () => ({
  getSyncEngine: () => ({ replayEvents: replayEventsMock, publish: publishMock }),
}))

const { syncRoutes } = await import('../routes/sync')

// ─── helpers ───────────────────────────────────────────────────────────────

function authedApp(user: { userId: string } = { userId: 'user-1' }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', user)
    await next()
  })
  app.route('/api', syncRoutes())
  return app
}

function unauthedApp() {
  const app = new Hono()
  app.route('/api', syncRoutes())
  return app
}

beforeEach(() => {
  findFirstMember.mockReset()
  findFirstMember.mockImplementation(async () => ({ id: 'mem-1', userId: 'user-1', workspaceId: 'ws-1' }))
  replayEventsMock.mockReset()
  replayEventsMock.mockImplementation(() => ({ events: [], cursor: null, hasMore: false }))
  publishMock.mockReset()
})

// ─── GET /sync ─────────────────────────────────────────────────────────────

describe('GET /sync — catch-up', () => {
  test('returns 401 when no auth context', async () => {
    const res = await unauthedApp().request('/api/sync?workspaceId=ws-1&since=0')
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  test('returns 401 when auth has no userId', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', {} as any)
      await next()
    })
    app.route('/api', syncRoutes())
    const res = await app.request('/api/sync?workspaceId=ws-1&since=0')
    expect(res.status).toBe(401)
  })

  test('returns 400 when workspaceId query param is missing', async () => {
    const res = await authedApp().request('/api/sync?since=0')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.message).toContain('workspaceId and since')
  })

  test('returns 400 when since query param is missing', async () => {
    const res = await authedApp().request('/api/sync?workspaceId=ws-1')
    expect(res.status).toBe(400)
  })

  test('returns 400 when since is not a valid timestamp', async () => {
    const res = await authedApp().request('/api/sync?workspaceId=ws-1&since=not-a-number')
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('valid timestamp')
  })

  test('returns 403 when user is not a workspace member', async () => {
    findFirstMember.mockImplementation(async () => null)
    const res = await authedApp().request('/api/sync?workspaceId=ws-1&since=0')
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  test('verifies membership using the authed userId and the workspaceId from the query', async () => {
    await authedApp({ userId: 'user-special' }).request(
      '/api/sync?workspaceId=ws-special&since=0',
    )
    expect(findFirstMember).toHaveBeenCalledWith({
      where: { userId: 'user-special', workspaceId: 'ws-special' },
    })
  })

  test('returns engine.replayEvents result with default limit 500', async () => {
    replayEventsMock.mockImplementation(() => ({
      events: [{ id: 'e1' }, { id: 'e2' }],
      cursor: 12345,
      hasMore: true,
    }))
    const res = await authedApp().request('/api/sync?workspaceId=ws-1&since=1000')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      events: [{ id: 'e1' }, { id: 'e2' }],
      cursor: 12345,
      hasMore: true,
    })
    expect(replayEventsMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      since: 1000,
      limit: 500,
    })
  })

  test('forwards a custom limit query param', async () => {
    await authedApp().request('/api/sync?workspaceId=ws-1&since=0&limit=25')
    expect(replayEventsMock.mock.calls[0][0].limit).toBe(25)
  })

  test('parses since as an integer (strips trailing chars)', async () => {
    await authedApp().request('/api/sync?workspaceId=ws-1&since=9999abc')
    expect(replayEventsMock.mock.calls[0][0].since).toBe(9999)
  })

  test('does NOT call replayEvents when authorization fails', async () => {
    findFirstMember.mockImplementation(async () => null)
    await authedApp().request('/api/sync?workspaceId=ws-1&since=0')
    expect(replayEventsMock).not.toHaveBeenCalled()
  })

  test('does NOT call replayEvents when validation fails', async () => {
    await authedApp().request('/api/sync') // no params
    expect(replayEventsMock).not.toHaveBeenCalled()
  })
})

// ─── POST /sync/events ─────────────────────────────────────────────────────

describe('POST /sync/events — publish', () => {
  function eventBody(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: 'PROJECT_CREATED',
      entityId: 'proj-1',
      payload: { name: 'New Project' },
      source: 'web',
      workspaceId: 'ws-1',
      ...over,
    })
  }

  test('returns 401 when no auth context', async () => {
    const res = await unauthedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    expect(res.status).toBe(401)
  })

  test('returns 400 when type is missing', async () => {
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ type: undefined }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })

  test('returns 400 when entityId is missing', async () => {
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ entityId: undefined }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when payload is missing', async () => {
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ payload: undefined }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when source is missing', async () => {
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ source: undefined }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when workspaceId is missing', async () => {
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ workspaceId: undefined }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 403 when user is not a member of the target workspace', async () => {
    findFirstMember.mockImplementation(async () => null)
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
  })

  test('publishes the event with auto-generated id, timestamp, and stamped userId', async () => {
    const before = Date.now()
    const res = await authedApp({ userId: 'publisher-1' }).request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    const after = Date.now()
    expect(res.status).toBe(200)

    expect(publishMock).toHaveBeenCalledTimes(1)
    const event = publishMock.mock.calls[0][0]
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(event.userId).toBe('publisher-1') // stamped from auth, not body
    expect(event.timestamp).toBeGreaterThanOrEqual(before)
    expect(event.timestamp).toBeLessThanOrEqual(after)
    expect(event.type).toBe('PROJECT_CREATED')
    expect(event.entityId).toBe('proj-1')
    expect(event.payload).toEqual({ name: 'New Project' })
    expect(event.source).toBe('web')
    expect(event.workspaceId).toBe('ws-1')
    expect(event.version).toBe(1) // default
  })

  test('returns { ok, eventId, serverTimestamp } shape', async () => {
    publishMock.mockImplementation((event: any) => {
      event.serverTimestamp = 9999999
    })
    const res = await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.eventId).toMatch(/^[0-9a-f]{8}-/)
    expect(body.serverTimestamp).toBe(9999999)
  })

  test('forwards an explicit version when provided', async () => {
    await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ version: 42 }),
    })
    expect(publishMock.mock.calls[0][0].version).toBe(42)
  })

  test('forwards an optional instanceId when provided', async () => {
    await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ instanceId: 'desktop-abc-123' }),
    })
    expect(publishMock.mock.calls[0][0].instanceId).toBe('desktop-abc-123')
  })

  test('omitting instanceId yields undefined on the event (not empty string)', async () => {
    await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    expect(publishMock.mock.calls[0][0].instanceId).toBeUndefined()
  })

  test('does NOT publish when authorization fails', async () => {
    findFirstMember.mockImplementation(async () => null)
    await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody(),
    })
    expect(publishMock).not.toHaveBeenCalled()
  })

  test('does NOT publish when validation fails', async () => {
    await authedApp().request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ type: undefined }),
    })
    expect(publishMock).not.toHaveBeenCalled()
  })

  test('two consecutive publishes get distinct event ids', async () => {
    const send = () =>
      authedApp().request('/api/sync/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: eventBody(),
      })
    await send()
    await send()
    const id1 = publishMock.mock.calls[0][0].id
    const id2 = publishMock.mock.calls[1][0].id
    expect(id1).not.toBe(id2)
  })

  test('membership lookup uses the workspaceId from the request body, not anywhere else', async () => {
    await authedApp({ userId: 'u-x' }).request('/api/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: eventBody({ workspaceId: 'ws-special' }),
    })
    expect(findFirstMember).toHaveBeenCalledWith({
      where: { userId: 'u-x', workspaceId: 'ws-special' },
    })
  })
})
