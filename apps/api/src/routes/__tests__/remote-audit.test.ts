// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'

// ─── Prisma mock ────────────────────────────────────────────────────────────

interface Store {
  instances: Map<string, { id: string; workspaceId: string }>
  members: Array<{ userId: string; workspaceId: string }>
  remoteActions: Array<any>
  pushSubs: Map<string, { id: string; instanceId: string; pushToken: string; platform: string; userId: string }>
  throwOnCreate: Error | null
  throwOnDelete: Error | null
}

const store: Store = {
  instances: new Map(),
  members: [],
  remoteActions: [],
  pushSubs: new Map(),
  throwOnCreate: null,
  throwOnDelete: null,
}

function subKey(instanceId: string, pushToken: string) {
  return `${instanceId}::${pushToken}`
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    instance: {
      findUnique: async ({ where }: any) => store.instances.get(where.id) ?? null,
    },
    member: {
      findFirst: async ({ where }: any) =>
        store.members.find(
          (m) => m.userId === where.userId && m.workspaceId === where.workspaceId,
        ) ?? null,
    },
    remoteAction: {
      create: async ({ data }: any) => {
        if (store.throwOnCreate) throw store.throwOnCreate
        const row = { id: `a${store.remoteActions.length + 1}`, createdAt: new Date(), ...data }
        store.remoteActions.push(row)
        return row
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = store.remoteActions.filter((a) => a.instanceId === where.instanceId)
        if (orderBy?.createdAt === 'desc') rows = rows.slice().reverse()
        return rows.slice(0, take)
      },
    },
    pushSubscription: {
      upsert: async ({ where, update, create }: any) => {
        const key = subKey(where.instanceId_pushToken.instanceId, where.instanceId_pushToken.pushToken)
        const existing = store.pushSubs.get(key)
        if (existing) {
          const merged = { ...existing, ...update }
          store.pushSubs.set(key, merged)
          return merged
        }
        const row = {
          id: `sub${store.pushSubs.size + 1}`,
          instanceId: create.instanceId,
          pushToken: create.pushToken,
          platform: create.platform,
          userId: create.userId,
        }
        store.pushSubs.set(key, row)
        return row
      },
      delete: async ({ where }: any) => {
        if (store.throwOnDelete) throw store.throwOnDelete
        const key = subKey(where.instanceId_pushToken.instanceId, where.instanceId_pushToken.pushToken)
        if (!store.pushSubs.has(key)) throw new Error('not found')
        store.pushSubs.delete(key)
        return { ok: true }
      },
    },
  },
}))

const mod = await import('../remote-audit')
const { remoteAuditRoutes, logRemoteAction, classifyAction } = mod

function makeApp(authUser: { userId: string } | null) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (authUser) c.set('auth' as any, authUser as any)
    await next()
  })
  app.route('/', remoteAuditRoutes())
  return app
}

beforeEach(() => {
  store.instances.clear()
  store.members = []
  store.remoteActions = []
  store.pushSubs.clear()
  store.throwOnCreate = null
  store.throwOnDelete = null
  store.instances.set('inst-1', { id: 'inst-1', workspaceId: 'ws-1' })
})

// ─── classifyAction ─────────────────────────────────────────────────────────

describe('classifyAction', () => {
  test('agent control paths', () => {
    expect(classifyAction('POST', '/agent/stop')).toBe('stop_agent')
    expect(classifyAction('POST', '/agent/session/reset')).toBe('reset_session')
    expect(classifyAction('POST', '/agent/heartbeat/trigger')).toBe('trigger_heartbeat')
    expect(classifyAction('POST', '/agent/chat')).toBe('remote_chat')
    expect(classifyAction('GET', '/agent/status')).toBe('get_status')
  })
  test('mode get vs set', () => {
    expect(classifyAction('GET', '/agent/mode')).toBe('get_mode')
    expect(classifyAction('PUT', '/agent/mode')).toBe('set_mode')
  })
  test('workspace browse + file view/edit', () => {
    expect(classifyAction('GET', '/agent/workspace/tree')).toBe('browse_files')
    expect(classifyAction('GET', '/agent/workspace/tree/sub')).toBe('browse_files')
    expect(classifyAction('GET', '/agent/workspace/files/a.ts')).toBe('view_file')
    expect(classifyAction('PUT', '/agent/workspace/files/a.ts')).toBe('edit_file')
  })
  test('health and unknown fallback', () => {
    expect(classifyAction('GET', '/health')).toBe('health_check')
    expect(classifyAction('POST', '/anything-else')).toBe('proxy_post')
    expect(classifyAction('GET', '/other')).toBe('proxy_get')
  })
})

// ─── logRemoteAction ────────────────────────────────────────────────────────

describe('logRemoteAction', () => {
  test('records the action via prisma', async () => {
    await logRemoteAction({ instanceId: 'inst-1', userId: 'u1', action: 'stop_agent' })
    expect(store.remoteActions).toHaveLength(1)
    expect(store.remoteActions[0]).toMatchObject({ instanceId: 'inst-1', userId: 'u1', action: 'stop_agent' })
  })
  test('swallows prisma errors (non-fatal audit logging)', async () => {
    store.throwOnCreate = new Error('db down')
    // Must NOT throw.
    await logRemoteAction({ instanceId: 'inst-1', userId: 'u1', action: 'x' })
    expect(store.remoteActions).toHaveLength(0)
  })
})

// ─── GET /instances/:id/audit ───────────────────────────────────────────────

describe('GET /instances/:id/audit', () => {
  test('401 when no auth', async () => {
    const app = makeApp(null)
    const res = await app.request('/instances/inst-1/audit')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
  })
  test('404 when instance missing', async () => {
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/missing/audit')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('not_found')
  })
  test('403 when user is not a workspace member', async () => {
    const app = makeApp({ userId: 'u-stranger' })
    const res = await app.request('/instances/inst-1/audit')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('forbidden')
  })
  test('returns recent actions for a member, honoring the default limit', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    for (let i = 0; i < 3; i++) {
      await logRemoteAction({ instanceId: 'inst-1', userId: 'u1', action: `a${i}` })
    }
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.actions).toHaveLength(3)
    expect(body.actions[0].action).toBe('a2')
  })
  test('clamps limit to 200', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/audit?limit=9999')
    expect(res.status).toBe(200)
  })
  test('respects custom limit query', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    for (let i = 0; i < 5; i++) {
      await logRemoteAction({ instanceId: 'inst-1', userId: 'u1', action: `a${i}` })
    }
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/audit?limit=2')
    const body = await res.json()
    expect(body.actions).toHaveLength(2)
  })
})

// ─── POST /instances/:id/subscribe-push ─────────────────────────────────────

describe('POST /instances/:id/subscribe-push', () => {
  test('401 without auth', async () => {
    const app = makeApp(null)
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 't', platform: 'ios' }),
    })
    expect(res.status).toBe(401)
  })
  test('404 when instance missing', async () => {
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/missing/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 't', platform: 'ios' }),
    })
    expect(res.status).toBe(404)
  })
  test('403 when not a member', async () => {
    const app = makeApp({ userId: 'u-stranger' })
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 't', platform: 'ios' }),
    })
    expect(res.status).toBe(403)
  })
  test('400 when body missing pushToken or platform', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    const app = makeApp({ userId: 'u1' })
    const r1 = await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 't' }),
    })
    expect(r1.status).toBe(400)
    const r2 = await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    })
    expect(r2.status).toBe(400)
  })
  test('200 + creates subscription on first call', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok-A', platform: 'ios' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.id).toBeTruthy()
    expect(store.pushSubs.size).toBe(1)
  })
  test('upserts (updates) when called twice with the same token', async () => {
    store.members.push({ userId: 'u1', workspaceId: 'ws-1' })
    const app = makeApp({ userId: 'u1' })
    await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok-B', platform: 'ios' }),
    })
    await app.request('/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok-B', platform: 'android' }),
    })
    expect(store.pushSubs.size).toBe(1)
    const row = store.pushSubs.get(subKey('inst-1', 'tok-B'))!
    expect(row.platform).toBe('android')
  })
})

// ─── DELETE /instances/:id/subscribe-push ───────────────────────────────────

describe('DELETE /instances/:id/subscribe-push', () => {
  test('401 without auth', async () => {
    const app = makeApp(null)
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 't' }),
    })
    expect(res.status).toBe(401)
  })
  test('400 when body missing pushToken', async () => {
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
  test('200 + deletes existing subscription', async () => {
    store.pushSubs.set(subKey('inst-1', 'tok-C'), {
      id: 's1', instanceId: 'inst-1', pushToken: 'tok-C', platform: 'ios', userId: 'u1',
    })
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 'tok-C' }),
    })
    expect(res.status).toBe(200)
    expect(store.pushSubs.size).toBe(0)
  })
  test('200 even when subscription does not exist (idempotent)', async () => {
    const app = makeApp({ userId: 'u1' })
    const res = await app.request('/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushToken: 'never-existed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
