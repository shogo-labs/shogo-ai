// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Audit Trail & Push Subscription Tests (Phase 2)
 *
 * Run: bun test apps/api/src/__tests__/remote-audit.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

const mockActions = [
  { id: 'ra-1', instanceId: 'inst-1', userId: 'user-1', action: 'stop_agent', path: '/agent/stop', method: 'POST', result: 'HTTP 200', createdAt: new Date() },
  { id: 'ra-2', instanceId: 'inst-1', userId: 'user-1', action: 'remote_chat', path: '/agent/chat', method: 'POST', result: 'HTTP 200', createdAt: new Date() },
]

const mockPrisma = {
  instance: {
    findUnique: mock(() => Promise.resolve({ id: 'inst-1', workspaceId: 'ws-1', name: 'test' })),
  },
  member: {
    findFirst: mock(() => Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' })),
  },
  remoteAction: {
    create: mock(() => Promise.resolve({ id: 'ra-new' })),
    findMany: mock(() => Promise.resolve([...mockActions])),
  },
  pushSubscription: {
    upsert: mock(() => Promise.resolve({ id: 'ps-1' })),
    delete: mock(() => Promise.resolve({ id: 'ps-1' })),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

const { remoteAuditRoutes, classifyAction, logRemoteAction } = await import('../routes/remote-audit')

const testUser = { id: 'user-1', userId: 'user-1', email: 'test@test.com' }

function createTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', testUser)
    await next()
  })
  app.route('/api', remoteAuditRoutes())
  return app
}

describe('classifyAction', () => {
  test('maps known paths correctly', () => {
    expect(classifyAction('POST', '/agent/stop')).toBe('stop_agent')
    expect(classifyAction('POST', '/agent/session/reset')).toBe('reset_session')
    expect(classifyAction('POST', '/agent/heartbeat/trigger')).toBe('trigger_heartbeat')
    expect(classifyAction('GET', '/agent/mode')).toBe('get_mode')
    expect(classifyAction('POST', '/agent/mode')).toBe('set_mode')
    expect(classifyAction('POST', '/agent/chat')).toBe('remote_chat')
    expect(classifyAction('GET', '/agent/status')).toBe('get_status')
    expect(classifyAction('GET', '/agent/workspace/tree')).toBe('browse_files')
    expect(classifyAction('GET', '/agent/workspace/files/foo.ts')).toBe('view_file')
    expect(classifyAction('PUT', '/agent/workspace/files/foo.ts')).toBe('edit_file')
    expect(classifyAction('GET', '/health')).toBe('health_check')
  })

  test('falls back to proxy_method for unknown paths', () => {
    expect(classifyAction('POST', '/agent/custom')).toBe('proxy_post')
    expect(classifyAction('DELETE', '/something')).toBe('proxy_delete')
  })
})

describe('logRemoteAction', () => {
  beforeEach(() => {
    mockPrisma.remoteAction.create.mockReset()
    mockPrisma.remoteAction.create.mockImplementation(() => Promise.resolve({ id: 'ra-new' }))
  })

  test('creates a remote action record', async () => {
    await logRemoteAction({
      instanceId: 'inst-1',
      userId: 'user-1',
      action: 'stop_agent',
      path: '/agent/stop',
      method: 'POST',
      result: 'HTTP 200',
    })
    expect(mockPrisma.remoteAction.create).toHaveBeenCalled()
  })

  test('does not throw when create fails', async () => {
    mockPrisma.remoteAction.create.mockImplementation(() => Promise.reject(new Error('DB error')))
    await logRemoteAction({
      instanceId: 'inst-1',
      userId: 'user-1',
      action: 'test',
    })
    // Should not throw
  })
})

describe('GET /api/instances/:id/audit', () => {
  beforeEach(() => {
    mockPrisma.instance.findUnique.mockReset()
    mockPrisma.instance.findUnique.mockImplementation(() =>
      Promise.resolve({ id: 'inst-1', workspaceId: 'ws-1', name: 'test' }),
    )
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    mockPrisma.remoteAction.findMany.mockReset()
    mockPrisma.remoteAction.findMany.mockImplementation(() => Promise.resolve([...mockActions]))
  })

  test('returns audit actions for instance', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/audit')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.actions).toHaveLength(2)
    expect(data.actions[0].action).toBe('stop_agent')
  })

  test('returns 404 for unknown instance', async () => {
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/instances/unknown/audit')
    expect(res.status).toBe(404)
  })

  test('returns 403 for non-member', async () => {
    mockPrisma.member.findFirst.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/audit')
    expect(res.status).toBe(403)
  })

  test('respects limit query param', async () => {
    const app = createTestApp()
    await app.request('/api/instances/inst-1/audit?limit=10')
    const call = mockPrisma.remoteAction.findMany.mock.calls[0][0]
    expect(call.take).toBe(10)
  })

  test('caps limit at 200', async () => {
    const app = createTestApp()
    await app.request('/api/instances/inst-1/audit?limit=999')
    const call = mockPrisma.remoteAction.findMany.mock.calls[0][0]
    expect(call.take).toBe(200)
  })
})

describe('POST /api/instances/:id/subscribe-push', () => {
  beforeEach(() => {
    mockPrisma.instance.findUnique.mockReset()
    mockPrisma.instance.findUnique.mockImplementation(() =>
      Promise.resolve({ id: 'inst-1', workspaceId: 'ws-1' }),
    )
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    mockPrisma.pushSubscription.upsert.mockReset()
    mockPrisma.pushSubscription.upsert.mockImplementation(() => Promise.resolve({ id: 'ps-1' }))
  })

  test('registers a push token', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'ExponentPushToken[xxxx]', platform: 'ios' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(mockPrisma.pushSubscription.upsert).toHaveBeenCalled()
  })

  test('returns 400 without pushToken', async () => {
    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 for unknown instance', async () => {
    mockPrisma.instance.findUnique.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/instances/unknown/subscribe-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'token', platform: 'android' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/instances/:id/subscribe-push', () => {
  test('unregisters a push token', async () => {
    mockPrisma.pushSubscription.delete.mockReset()
    mockPrisma.pushSubscription.delete.mockImplementation(() => Promise.resolve({ id: 'ps-1' }))

    const app = createTestApp()
    const res = await app.request('/api/instances/inst-1/subscribe-push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushToken: 'ExponentPushToken[xxxx]' }),
    })
    expect(res.status).toBe(200)
  })
})
