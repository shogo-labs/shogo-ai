// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Coverage-gap closer for src/routes/remote-audit.ts.
 *
 * The existing remote-audit.test.ts always sets `c.set('auth', testUser)`
 * before the route runs, so the unauthorized (401) branches never fire.
 * It also doesn't exercise the 400 ("pushToken required") branch on the
 * DELETE handler. This file covers those gaps.
 *
 * Targets: lines 59 (GET /audit 401), 88 (POST /subscribe 401),
 * 100 (POST /subscribe 403 non-member), 128 (DELETE /subscribe 401),
 * 133 (DELETE /subscribe 400).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── Prisma mock (reused shape from remote-audit.test.ts) ──────────────────

const mockInstance = { id: 'inst-1', workspaceId: 'ws-1', name: 'test' }
const findUniqueInstance = mock(async () => mockInstance as any)
const findFirstMember = mock(async () => ({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }) as any)
const upsertSub = mock(async () => ({ id: 'ps-1' }))
const deleteSub = mock(async () => ({ id: 'ps-1' }))

mock.module('../lib/prisma', () => ({
  prisma: {
    instance: { findUnique: findUniqueInstance },
    member: { findFirst: findFirstMember },
    pushSubscription: { upsert: upsertSub, delete: deleteSub },
    remoteAction: {
      create: mock(async () => ({ id: 'ra' })),
      findMany: mock(async () => []),
    },
  },
}))

const { remoteAuditRoutes } = await import('../routes/remote-audit')

// ─── App helpers ───────────────────────────────────────────────────────────

function createUnauthedApp() {
  // No auth middleware — c.get('auth') returns undefined, exercising the
  // `if (!auth?.userId)` guards on every route.
  const app = new Hono()
  app.route('/api', remoteAuditRoutes())
  return app
}

function createAuthedApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1', email: 'u@test.com' })
    await next()
  })
  app.route('/api', remoteAuditRoutes())
  return app
}

beforeEach(() => {
  findUniqueInstance.mockClear()
  findFirstMember.mockClear()
  findUniqueInstance.mockImplementation(async () => mockInstance as any)
  findFirstMember.mockImplementation(async () => ({
    id: 'member-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
  }) as any)
})

// ─── GET /instances/:id/audit — 401 ────────────────────────────────────────

describe('GET /instances/:id/audit — unauthorized', () => {
  test('returns 401 unauthorized when no auth context is set', async () => {
    const app = createUnauthedApp()
    const res = await app.request('/api/instances/inst-1/audit')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
    expect(body.error.message).toBe('Authentication required')
  })

  test('returns 401 when auth is set but userId is missing', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', { email: 'partial@test.com' } as any) // no userId
      await next()
    })
    app.route('/api', remoteAuditRoutes())

    const res = await app.request('/api/instances/inst-1/audit')
    expect(res.status).toBe(401)
  })

  test('401 short-circuits before any prisma access (no DB calls)', async () => {
    findUniqueInstance.mockClear()
    findFirstMember.mockClear()
    const app = createUnauthedApp()
    await app.request('/api/instances/inst-1/audit')
    expect(findUniqueInstance).not.toHaveBeenCalled()
    expect(findFirstMember).not.toHaveBeenCalled()
  })
})

// ─── POST /instances/:id/subscribe-push — 401 + 403 ────────────────────────

describe('POST /instances/:id/subscribe-push — unauthorized and forbidden', () => {
  test('returns 401 when no auth context is set', async () => {
    const app = createUnauthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok', platform: 'ios' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  test('returns 403 forbidden when user is not a workspace member', async () => {
    findFirstMember.mockImplementation(async () => null)
    const app = createAuthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok', platform: 'ios' }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('forbidden')
    expect(body.error.message).toBe('Not a member of this workspace')
  })

  test('returns 404 when instance does not exist (precedes member check)', async () => {
    findUniqueInstance.mockImplementation(async () => null)
    const app = createAuthedApp()
    const res = await app.request('/api/instances/missing/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok', platform: 'ios' }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 400 invalid_request when pushToken is missing', async () => {
    const app = createAuthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }), // no pushToken
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_request')
  })

  test('returns 400 invalid_request when platform is missing', async () => {
    const app = createAuthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok' }), // no platform
    })
    expect(res.status).toBe(400)
  })
})

// ─── DELETE /instances/:id/subscribe-push — 401 + 400 ──────────────────────

describe('DELETE /instances/:id/subscribe-push — unauthorized and validation', () => {
  test('returns 401 when no auth context is set', async () => {
    const app = createUnauthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  test('returns 400 invalid_request when pushToken is missing from the body', async () => {
    const app = createAuthedApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // no pushToken
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_request')
    expect(body.error.message).toBe('pushToken required')
  })

  test('401 short-circuits before any prisma access on DELETE', async () => {
    deleteSub.mockClear()
    const app = createUnauthedApp()
    await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok' }),
    })
    expect(deleteSub).not.toHaveBeenCalled()
  })
})
