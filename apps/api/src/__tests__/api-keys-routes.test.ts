// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

let memberResult: any = { id: 'member-1', workspaceId: 'ws-1' }
let apiKeyFindUniqueResult: any = null
let apiKeyCreateResult: any = null
let workspaceResult: any = { id: 'ws-1', name: 'Workspace', slug: 'workspace' }
let updateShouldReject = false
const apiKeyUpdates: any[] = []
const apiKeyUpdateManyCalls: any[] = []
const apiKeyFindManyCalls: any[] = []

const mockPrisma = {
  member: {
    findFirst: mock(async () => memberResult),
  },
  apiKey: {
    create: mock(async (args: any) => apiKeyCreateResult ?? {
      id: 'key-1',
      name: args.data.name,
      keyPrefix: args.data.keyPrefix,
      workspaceId: args.data.workspaceId,
      expiresAt: args.data.expiresAt ?? null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      kind: args.data.kind,
      deviceId: args.data.deviceId ?? null,
      deviceName: args.data.deviceName ?? null,
      devicePlatform: args.data.devicePlatform ?? null,
      deviceAppVersion: args.data.deviceAppVersion ?? null,
    }),
    findMany: mock(async (args: any) => {
      apiKeyFindManyCalls.push(args)
      return [{ id: 'key-1', name: 'Key', kind: 'user' }]
    }),
    findUnique: mock(async () => apiKeyFindUniqueResult),
    update: mock(async (args: any) => {
      if (updateShouldReject) throw new Error('update failed')
      apiKeyUpdates.push(args)
      return { id: args.where.id, ...args.data }
    }),
    updateMany: mock(async (args: any) => {
      apiKeyUpdateManyCalls.push(args)
      return { count: 1 }
    }),
  },
  workspace: {
    findUnique: mock(async () => workspaceResult),
  },
  $transaction: mock(async (fn: any) => fn({
    apiKey: {
      updateMany: mockPrisma.apiKey.updateMany,
      create: mockPrisma.apiKey.create,
    },
  })),
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

const { apiKeyRoutes, resolveApiKey } = await import('../routes/api-keys')

beforeEach(() => {
  memberResult = { id: 'member-1', workspaceId: 'ws-1' }
  apiKeyFindUniqueResult = null
  apiKeyCreateResult = null
  workspaceResult = { id: 'ws-1', name: 'Workspace', slug: 'workspace' }
  updateShouldReject = false
  apiKeyUpdates.length = 0
  apiKeyUpdateManyCalls.length = 0
  apiKeyFindManyCalls.length = 0
  mockPrisma.member.findFirst.mockClear()
  mockPrisma.apiKey.create.mockClear()
  mockPrisma.apiKey.findMany.mockClear()
  mockPrisma.apiKey.findUnique.mockClear()
  mockPrisma.apiKey.update.mockClear()
  mockPrisma.apiKey.updateMany.mockClear()
  mockPrisma.workspace.findUnique.mockClear()
  mockPrisma.$transaction.mockClear()
})

function makeApp(auth: any = { userId: 'user-1' }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/', apiKeyRoutes())
  return app
}

describe('apiKeyRoutes create/list/delete', () => {
  test('create rejects unauthenticated, missing workspace, and non-member requests', async () => {
    expect((await makeApp(null).request('/api-keys', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await makeApp().request('/api-keys', { method: 'POST', body: '{}' })).status).toBe(400)

    memberResult = null
    const forbidden = await makeApp().request('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(forbidden.status).toBe(403)
  })

  test('creates a user API key with prefix, expiry, and default name', async () => {
    const res = await makeApp().request('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws-1', expiresInDays: 7 }),
    })

    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.key).toStartWith('shogo_sk_')
    expect(body.keyPrefix).toBe(body.key.slice(0, 'shogo_sk_'.length + 8))
    expect(body.name).toBe('Shogo Local')
    expect(body.kind).toBe('user')
    expect(mockPrisma.apiKey.create.mock.calls[0][0].data.keyHash).toHaveLength(64)
  })

  test('device key validates deviceId, defaults workspace, revokes old device key, and truncates metadata', async () => {
    expect((await makeApp().request('/api-keys/device', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'short' }),
    })).status).toBe(400)

    const res = await makeApp().request('/api-keys/device', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-123',
        deviceName: 'D'.repeat(140),
        devicePlatform: 'darwin'.repeat(10),
        deviceAppVersion: '1.'.repeat(40),
      }),
    })

    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.key).toStartWith('shogo_sk_')
    expect(body.workspace).toEqual(workspaceResult)
    expect(apiKeyUpdateManyCalls[0].where).toMatchObject({
      workspaceId: 'ws-1',
      deviceId: 'device-123',
      kind: 'device',
      revokedAt: null,
    })
    const created = mockPrisma.apiKey.create.mock.calls[0][0].data
    expect(created.deviceName).toHaveLength(120)
    expect(created.devicePlatform).toHaveLength(32)
    expect(created.deviceAppVersion).toHaveLength(32)
  })

  test('device key rejects missing workspace membership and missing default workspace', async () => {
    memberResult = null
    expect((await makeApp().request('/api-keys/device', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws-2', deviceId: 'device-123' }),
    })).status).toBe(403)

    expect((await makeApp().request('/api-keys/device', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-123' }),
    })).status).toBe(404)
  })

  test('device key accepts explicit workspace membership and stores provided metadata', async () => {
    const res = await makeApp().request('/api-keys/device', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-explicit',
        deviceId: 'device-explicit',
        deviceName: 'Desktop',
        devicePlatform: 'darwin',
        deviceAppVersion: '1.2.3',
      }),
    })

    expect(res.status).toBe(200)
    expect(mockPrisma.member.findFirst.mock.calls[0][0]).toEqual({
      where: { userId: 'user-1', workspaceId: 'ws-explicit' },
    })
    expect(apiKeyUpdateManyCalls[0].where.workspaceId).toBe('ws-explicit')
    const created = mockPrisma.apiKey.create.mock.calls[0][0].data
    expect(created).toMatchObject({
      workspaceId: 'ws-explicit',
      deviceName: 'Desktop',
      devicePlatform: 'darwin',
      deviceAppVersion: '1.2.3',
    })
  })

  test('lists keys with optional kind filter after membership check', async () => {
    const missingWorkspace = await makeApp().request('/api-keys')
    expect(missingWorkspace.status).toBe(400)

    const res = await makeApp().request('/api-keys?workspaceId=ws-1&kind=device')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ keys: [{ id: 'key-1', name: 'Key', kind: 'user' }] })
    expect(apiKeyFindManyCalls[0].where).toMatchObject({
      workspaceId: 'ws-1',
      revokedAt: null,
      kind: 'device',
    })
  })

  test('list rejects unauthenticated and non-member requests and ignores invalid kind filters', async () => {
    expect((await makeApp(null).request('/api-keys?workspaceId=ws-1')).status).toBe(401)

    memberResult = null
    expect((await makeApp().request('/api-keys?workspaceId=ws-1')).status).toBe(403)

    memberResult = { id: 'member-1' }
    const res = await makeApp().request('/api-keys?workspaceId=ws-1&kind=admin')

    expect(res.status).toBe(200)
    expect(apiKeyFindManyCalls.at(-1).where).toEqual({
      workspaceId: 'ws-1',
      revokedAt: null,
    })
  })

  test('delete handles missing keys, forbidden workspace, and successful revocation', async () => {
    expect((await makeApp(null).request('/api-keys/key-1', { method: 'DELETE' })).status).toBe(401)

    apiKeyFindUniqueResult = null
    expect((await makeApp().request('/api-keys/missing', { method: 'DELETE' })).status).toBe(404)

    apiKeyFindUniqueResult = { id: 'key-1', workspaceId: 'ws-1' }
    memberResult = null
    expect((await makeApp().request('/api-keys/key-1', { method: 'DELETE' })).status).toBe(403)

    memberResult = { id: 'member-1' }
    const res = await makeApp().request('/api-keys/key-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(apiKeyUpdates.at(-1)).toMatchObject({
      where: { id: 'key-1' },
      data: { revokedAt: expect.any(Date) },
    })
  })
})

describe('apiKeyRoutes validate and heartbeat', () => {
  const validKey = 'shogo_sk_valid'

  test('validate rejects invalid, missing, revoked, and expired keys', async () => {
    expect((await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: 'bad' }),
    })).status).toBe(400)

    apiKeyFindUniqueResult = null
    expect(await (await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })).json()).toEqual({ valid: false, error: 'Key not found' })

    apiKeyFindUniqueResult = { revokedAt: new Date() }
    expect(await (await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })).json()).toEqual({ valid: false, error: 'Key has been revoked' })

    apiKeyFindUniqueResult = { revokedAt: null, expiresAt: new Date(Date.now() - 1) }
    expect(await (await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })).json()).toEqual({ valid: false, error: 'Key has expired' })
  })

  test('validate returns workspace, user, and device metadata for active keys', async () => {
    apiKeyFindUniqueResult = {
      id: 'key-1',
      revokedAt: null,
      expiresAt: null,
      workspace: { id: 'ws-1', name: 'Workspace', slug: 'workspace' },
      user: { id: 'user-1', name: 'User', email: 'user@example.com' },
      kind: 'device',
      deviceId: 'device-1',
      deviceName: 'Laptop',
    }

    const res = await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })

    expect(await res.json()).toEqual({
      valid: true,
      workspace: apiKeyFindUniqueResult.workspace,
      user: apiKeyFindUniqueResult.user,
      kind: 'device',
      deviceId: 'device-1',
      deviceName: 'Laptop',
    })
    expect(apiKeyUpdates.at(-1)).toMatchObject({
      where: { id: 'key-1' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  test('validate still succeeds when lastUsedAt update fails', async () => {
    updateShouldReject = true
    apiKeyFindUniqueResult = {
      id: 'key-1',
      revokedAt: null,
      expiresAt: null,
      workspace: { id: 'ws-1' },
      user: { id: 'user-1', name: null, email: 'user@example.com' },
      kind: 'user',
      deviceId: null,
      deviceName: null,
    }

    const res = await makeApp().request('/api-keys/validate', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(true)
    expect(apiKeyUpdates).toHaveLength(0)
  })

  test('heartbeat validates key state and updates device app version only for device keys', async () => {
    expect((await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: 'bad' }),
    })).status).toBe(400)

    apiKeyFindUniqueResult = null
    expect((await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })).status).toBe(401)

    apiKeyFindUniqueResult = { id: 'key-1', revokedAt: null, expiresAt: null, kind: 'device' }
    const res = await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: validKey, deviceAppVersion: 'v'.repeat(40) }),
    })

    expect(res.status).toBe(200)
    expect(apiKeyUpdates.at(-1).data).toMatchObject({
      lastSeenAt: expect.any(Date),
      deviceAppVersion: 'v'.repeat(32),
    })

    apiKeyFindUniqueResult = { id: 'key-2', revokedAt: null, expiresAt: null, kind: 'user' }
    await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: validKey, deviceAppVersion: '1.0.0' }),
    })
    expect(apiKeyUpdates.at(-1).data.deviceAppVersion).toBeUndefined()
  })

  test('heartbeat rejects expired keys and still returns ok when update fails', async () => {
    apiKeyFindUniqueResult = { id: 'expired', revokedAt: null, expiresAt: new Date(Date.now() - 1), kind: 'device' }
    expect((await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: validKey }),
    })).status).toBe(401)

    updateShouldReject = true
    apiKeyFindUniqueResult = { id: 'key-ok', revokedAt: null, expiresAt: null, kind: 'device' }
    const res = await makeApp().request('/api-keys/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ key: validKey, deviceAppVersion: '3.0.0' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('resolveApiKey', () => {
  test('returns null for invalid, missing, revoked, and expired keys', async () => {
    expect(await resolveApiKey('bad')).toBeNull()

    apiKeyFindUniqueResult = null
    expect(await resolveApiKey('shogo_sk_missing')).toBeNull()

    apiKeyFindUniqueResult = { revokedAt: new Date() }
    expect(await resolveApiKey('shogo_sk_revoked')).toBeNull()

    apiKeyFindUniqueResult = { revokedAt: null, expiresAt: new Date(Date.now() - 1) }
    expect(await resolveApiKey('shogo_sk_expired')).toBeNull()
  })

  test('updates last-used fields and returns context for active device keys', async () => {
    apiKeyFindUniqueResult = {
      id: 'key-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
      deviceId: 'device-1',
    }

    const result = await resolveApiKey('shogo_sk_active', {
      deviceAppVersion: '2.'.repeat(40),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result).toEqual({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'device',
      deviceId: 'device-1',
    })
    expect(apiKeyUpdates.at(-1).data).toMatchObject({
      lastUsedAt: expect.any(Date),
      lastSeenAt: expect.any(Date),
      deviceAppVersion: '2.'.repeat(16),
    })
  })

  test('updates only lastUsedAt and returns context for active user keys', async () => {
    apiKeyFindUniqueResult = {
      id: 'key-user',
      workspaceId: 'ws-2',
      userId: 'user-2',
      revokedAt: null,
      expiresAt: null,
      kind: 'user',
      deviceId: null,
    }

    const result = await resolveApiKey('shogo_sk_user', { deviceAppVersion: 'ignored' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result).toEqual({
      workspaceId: 'ws-2',
      userId: 'user-2',
      kind: 'user',
      deviceId: null,
    })
    expect(apiKeyUpdates.at(-1).data).toEqual({ lastUsedAt: expect.any(Date) })
  })
})
