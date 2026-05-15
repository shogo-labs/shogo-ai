// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/api-keys.ts — Shogo Cloud API key management.
 *
 * Six HTTP endpoints + the resolveApiKey() helper used by the AI proxy.
 * Strategy:
 *
 *  - Mock prisma (apiKey, member, workspace)
 *  - Mock ../lib/api-keys-mint so we control the {fullKey, keyHash,
 *    keyPrefix} output deterministically (real crypto is exercised by
 *    that module's own tests)
 *  - Build a tiny Hono app that wires the auth context the route
 *    expects
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── prisma mock ──────────────────────────────────────────────────────────

const memberFindFirst = mock(async (_: any): Promise<any> => null)
const apiKeyCreate = mock(async (_: any): Promise<any> => ({}))
const apiKeyFindMany = mock(async (_: any): Promise<any[]> => [])
const apiKeyFindUnique = mock(async (_: any): Promise<any> => null)
const apiKeyUpdate = mock(async (_: any): Promise<any> => ({}))
const workspaceFindUnique = mock(async (_: any): Promise<any> => null)

mock.module('../lib/prisma', () => ({
  prisma: {
    member: { findFirst: memberFindFirst },
    apiKey: {
      create: apiKeyCreate,
      findMany: apiKeyFindMany,
      findUnique: apiKeyFindUnique,
      update: apiKeyUpdate,
    },
    workspace: { findUnique: workspaceFindUnique },
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

// ─── api-keys-mint mock ───────────────────────────────────────────────────

const generateApiKeyMock = mock(async () => ({
  fullKey: 'shogo_sk_FULL_PLAINTEXT',
  keyHash: 'hash-abc',
  keyPrefix: 'shogo_sk_FULL_PL',
}))
const hashApiKeyMock = mock(async (key: string) => `hash::${key}`)
const mintDeviceApiKeyMock = mock(async (args: any) => ({
  fullKey: 'shogo_sk_DEVICE_PLAINTEXT',
  keyPrefix: 'shogo_sk_DEVICE_',
  apiKey: {
    id: 'apikey-dev-1',
    name: args.deviceName ?? args.defaultDeviceName ?? 'Shogo Desktop',
    workspaceId: args.workspaceId,
    userId: args.userId,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    kind: 'device',
    deviceId: args.deviceId,
    deviceName: args.deviceName ?? null,
    devicePlatform: args.devicePlatform ?? null,
    deviceAppVersion: args.deviceAppVersion ?? null,
  },
}))

mock.module('../lib/api-keys-mint', () => ({
  SHOGO_API_KEY_PREFIX: 'shogo_sk_',
  generateApiKey: generateApiKeyMock,
  hashApiKey: hashApiKeyMock,
  mintDeviceApiKey: mintDeviceApiKeyMock,
}))

// ─── load routes ──────────────────────────────────────────────────────────

const { apiKeyRoutes, resolveApiKey } = await import('../routes/api-keys')

function authedApp(user: { userId: string } | null = { userId: 'user-1' }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (user) c.set('auth', user as any)
    await next()
  })
  app.route('/api', apiKeyRoutes())
  return app
}

beforeEach(() => {
  memberFindFirst.mockReset()
  memberFindFirst.mockImplementation(async () => ({
    id: 'mem-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
  }))
  apiKeyCreate.mockReset()
  apiKeyCreate.mockImplementation(async ({ data }: any) => ({
    id: 'apikey-1',
    ...data,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }))
  apiKeyFindMany.mockReset()
  apiKeyFindMany.mockImplementation(async () => [])
  apiKeyFindUnique.mockReset()
  apiKeyFindUnique.mockImplementation(async () => null)
  apiKeyUpdate.mockReset()
  apiKeyUpdate.mockImplementation(async () => ({}))
  workspaceFindUnique.mockReset()
  workspaceFindUnique.mockImplementation(async () => ({
    id: 'ws-1',
    name: 'Personal',
    slug: 'personal',
  }))

  generateApiKeyMock.mockReset()
  generateApiKeyMock.mockImplementation(async () => ({
    fullKey: 'shogo_sk_FULL_PLAINTEXT',
    keyHash: 'hash-abc',
    keyPrefix: 'shogo_sk_FULL_PL',
  }))
  hashApiKeyMock.mockReset()
  hashApiKeyMock.mockImplementation(async (key: string) => `hash::${key}`)
  mintDeviceApiKeyMock.mockReset()
  mintDeviceApiKeyMock.mockImplementation(async (args: any) => ({
    fullKey: 'shogo_sk_DEVICE_PLAINTEXT',
    keyPrefix: 'shogo_sk_DEVICE_',
    apiKey: {
      id: 'apikey-dev-1',
      name: args.deviceName ?? 'Shogo Desktop',
      workspaceId: args.workspaceId,
      userId: args.userId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      kind: 'device',
      deviceId: args.deviceId,
      deviceName: args.deviceName ?? null,
      devicePlatform: args.devicePlatform ?? null,
      deviceAppVersion: args.deviceAppVersion ?? null,
    },
  }))
})

// ─── POST /api-keys ───────────────────────────────────────────────────────

describe('POST /api-keys — create user key', () => {
  test('401 when no auth', async () => {
    const res = await authedApp(null).request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  test('400 when workspaceId missing', async () => {
    const res = await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'k' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })

  test('403 when user is not a member of the workspace', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-not-mine' }),
    })
    expect(res.status).toBe(403)
  })

  test('happy path: returns the FULL plaintext key exactly once', async () => {
    const res = await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI runner', workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.key).toBe('shogo_sk_FULL_PLAINTEXT')
    expect(body.keyPrefix).toBe('shogo_sk_FULL_PL')
    expect(body.kind).toBe('user')
    expect(body.name).toBe('CI runner')
  })

  test('name defaults to "Shogo Local" when omitted', async () => {
    const res = await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(200)
    const created = apiKeyCreate.mock.calls[0][0].data
    expect(created.name).toBe('Shogo Local')
  })

  test('persists kind="user" and keyHash (NOT plaintext) to the DB', async () => {
    await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    const created = apiKeyCreate.mock.calls[0][0].data
    expect(created.kind).toBe('user')
    expect(created.keyHash).toBe('hash-abc')
    expect(created.keyPrefix).toBe('shogo_sk_FULL_PL')
    expect((created as any).key).toBeUndefined() // never store plaintext
  })

  test('expiresInDays maps to a future Date (~N days ahead)', async () => {
    const before = Date.now()
    await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', expiresInDays: 30 }),
    })
    const after = Date.now()
    const expiresAt = (apiKeyCreate.mock.calls[0][0].data.expiresAt as Date).getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 86400_000 - 50)
    expect(expiresAt).toBeLessThanOrEqual(after + 30 * 86400_000 + 50)
  })

  test('omitting expiresInDays → expiresAt is null (no expiry)', async () => {
    await authedApp().request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(apiKeyCreate.mock.calls[0][0].data.expiresAt).toBeNull()
  })
})

// ─── POST /api-keys/device ────────────────────────────────────────────────

describe('POST /api-keys/device — mint device key', () => {
  test('401 when no auth', async () => {
    const res = await authedApp(null).request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'desk-uuid-1234' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when deviceId missing', async () => {
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })

  test('400 when deviceId is too short (<8 chars)', async () => {
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when deviceId is not a string', async () => {
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 12345678 }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when JSON body is malformed (caught + treated as no deviceId)', async () => {
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })

  test('explicit workspaceId: 403 when user is not a member', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'desk-uuid-1234', workspaceId: 'ws-other' }),
    })
    expect(res.status).toBe(403)
  })

  test('no workspaceId: 404 when user has no memberships', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'desk-uuid-1234' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('no_workspace')
  })

  test('no workspaceId: defaults to the EARLIEST membership (orderBy createdAt asc)', async () => {
    memberFindFirst.mockImplementation(async (args: any) => {
      // The "no workspaceId provided" path queries with orderBy.
      if (args?.orderBy) return { workspaceId: 'ws-personal' }
      return null
    })
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'desk-uuid-1234' }),
    })
    expect(res.status).toBe(200)
    // The order-by call MUST sort ascending by createdAt
    const orderByCall = memberFindFirst.mock.calls.find((c: any) => c[0]?.orderBy)
    expect(orderByCall![0].orderBy).toEqual({ createdAt: 'asc' })
    // And the personal workspaceId is what got passed to mintDeviceApiKey
    expect(mintDeviceApiKeyMock.mock.calls[0][0].workspaceId).toBe('ws-personal')
  })

  test('happy path: forwards full device metadata to mintDeviceApiKey', async () => {
    const res = await authedApp({ userId: 'user-X' }).request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        deviceId: 'desk-uuid-1234',
        deviceName: 'Anya Mac',
        devicePlatform: 'darwin-arm64',
        deviceAppVersion: '1.2.3',
      }),
    })
    expect(res.status).toBe(200)
    expect(mintDeviceApiKeyMock).toHaveBeenCalledTimes(1)
    const args = mintDeviceApiKeyMock.mock.calls[0][0]
    expect(args).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'user-X',
      deviceId: 'desk-uuid-1234',
      deviceName: 'Anya Mac',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.3',
      defaultDeviceName: 'Shogo Desktop',
    })
    expect(args.prisma).toBeDefined() // prisma instance forwarded
  })

  test('happy path: response includes plaintext key, workspace, device metadata', async () => {
    const res = await authedApp().request('/api/api-keys/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'desk-uuid-1234',
        workspaceId: 'ws-1',
        deviceName: 'My Laptop',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.key).toBe('shogo_sk_DEVICE_PLAINTEXT')
    expect(body.kind).toBe('device')
    expect(body.deviceId).toBe('desk-uuid-1234')
    expect(body.deviceName).toBe('My Laptop')
    expect(body.workspace).toEqual({
      id: 'ws-1',
      name: 'Personal',
      slug: 'personal',
    })
  })
})

// ─── GET /api-keys ────────────────────────────────────────────────────────

describe('GET /api-keys — list', () => {
  test('401 when no auth', async () => {
    const res = await authedApp(null).request('/api/api-keys?workspaceId=ws-1')
    expect(res.status).toBe(401)
  })

  test('400 when workspaceId query missing', async () => {
    const res = await authedApp().request('/api/api-keys')
    expect(res.status).toBe(400)
  })

  test('403 when not a member', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys?workspaceId=ws-1')
    expect(res.status).toBe(403)
  })

  test('returns active keys ordered by lastSeenAt desc, then createdAt desc', async () => {
    apiKeyFindMany.mockImplementation(async () => [
      { id: 'k1', name: 'A', kind: 'user' },
      { id: 'k2', name: 'B', kind: 'device' },
    ])
    const res = await authedApp().request('/api/api-keys?workspaceId=ws-1')
    expect(res.status).toBe(200)
    expect((await res.json()).keys).toEqual([
      { id: 'k1', name: 'A', kind: 'user' },
      { id: 'k2', name: 'B', kind: 'device' },
    ])
    const call = apiKeyFindMany.mock.calls[0][0]
    expect(call.where).toEqual({ workspaceId: 'ws-1', revokedAt: null })
    expect(call.orderBy).toEqual([
      { lastSeenAt: 'desc' },
      { createdAt: 'desc' },
    ])
  })

  test('?kind=user filter is applied to the where clause', async () => {
    await authedApp().request('/api/api-keys?workspaceId=ws-1&kind=user')
    expect(apiKeyFindMany.mock.calls[0][0].where.kind).toBe('user')
  })

  test('?kind=device filter is applied', async () => {
    await authedApp().request('/api/api-keys?workspaceId=ws-1&kind=device')
    expect(apiKeyFindMany.mock.calls[0][0].where.kind).toBe('device')
  })

  test('?kind=garbage is IGNORED (no kind clause)', async () => {
    await authedApp().request('/api/api-keys?workspaceId=ws-1&kind=bogus')
    expect(apiKeyFindMany.mock.calls[0][0].where.kind).toBeUndefined()
  })

  test('selected columns DO NOT include keyHash (no plaintext-equivalent leakage)', async () => {
    await authedApp().request('/api/api-keys?workspaceId=ws-1')
    const select = apiKeyFindMany.mock.calls[0][0].select
    expect(select.keyHash).toBeUndefined()
    expect(select.keyPrefix).toBe(true) // displayed
    expect(select.id).toBe(true)
  })
})

// ─── DELETE /api-keys/:id ────────────────────────────────────────────────

describe('DELETE /api-keys/:id — revoke', () => {
  test('401 when no auth', async () => {
    const res = await authedApp(null).request('/api/api-keys/k1', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  test('404 when key not found', async () => {
    apiKeyFindUnique.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys/k404', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('403 when key belongs to a different workspace than the caller', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      workspaceId: 'ws-OTHER',
    }))
    memberFindFirst.mockImplementation(async () => null)
    const res = await authedApp().request('/api/api-keys/k1', { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(apiKeyUpdate).not.toHaveBeenCalled() // crucial: no soft-delete on unauthorized target
  })

  test('happy path: marks revokedAt and returns ok', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      workspaceId: 'ws-1',
    }))
    const before = Date.now()
    const res = await authedApp().request('/api/api-keys/k1', { method: 'DELETE' })
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(apiKeyUpdate).toHaveBeenCalledTimes(1)
    const updateCall = apiKeyUpdate.mock.calls[0][0]
    expect(updateCall.where).toEqual({ id: 'k1' })
    const revokedAt = (updateCall.data.revokedAt as Date).getTime()
    expect(revokedAt).toBeGreaterThanOrEqual(before)
    expect(revokedAt).toBeLessThanOrEqual(after)
  })
})

// ─── POST /api-keys/validate ──────────────────────────────────────────────

describe('POST /api-keys/validate — public', () => {
  test('400 when key has wrong prefix', async () => {
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-other' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ valid: false, error: 'Invalid key format' })
  })

  test('400 when no key provided', async () => {
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('valid:false when key not found in DB', async () => {
    apiKeyFindUnique.mockImplementation(async () => null)
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_unknown' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false, error: 'Key not found' })
  })

  test('valid:false when key has been revoked', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: new Date('2025-01-01'),
      kind: 'user',
      user: { id: 'u', name: 'n', email: 'e' },
      workspace: { id: 'w', name: 'n', slug: 's' },
    }))
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_revoked' }),
    })
    expect((await res.json()).error).toBe('Key has been revoked')
  })

  test('valid:false when key has expired', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: new Date('2020-01-01'), // long past
      kind: 'user',
      user: { id: 'u', name: 'n', email: 'e' },
      workspace: { id: 'w', name: 'n', slug: 's' },
    }))
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_expired' }),
    })
    expect((await res.json()).error).toBe('Key has expired')
  })

  test('happy path: returns workspace + user + kind + device metadata', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
      deviceId: 'desk-1',
      deviceName: 'Anya Mac',
      user: { id: 'u-1', name: 'Anya', email: 'a@x.com' },
      workspace: { id: 'w-1', name: 'Personal', slug: 'personal' },
    }))
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_ok' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      valid: true,
      workspace: { id: 'w-1', name: 'Personal', slug: 'personal' },
      user: { id: 'u-1', name: 'Anya', email: 'a@x.com' },
      kind: 'device',
      deviceId: 'desk-1',
      deviceName: 'Anya Mac',
    })
    expect(apiKeyUpdate).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  test('lastUsedAt update failure is swallowed (still returns valid:true)', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'user',
      user: { id: 'u', name: 'n', email: 'e' },
      workspace: { id: 'w', name: 'n', slug: 's' },
    }))
    apiKeyUpdate.mockImplementation(async () => {
      throw new Error('db hiccup')
    })
    const res = await authedApp(null).request('/api/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_ok' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(true)
  })
})

// ─── POST /api-keys/heartbeat ─────────────────────────────────────────────

describe('POST /api-keys/heartbeat — public', () => {
  test('400 when key has wrong prefix', async () => {
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-other' }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when JSON body is malformed', async () => {
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('401 when key not found', async () => {
    apiKeyFindUnique.mockImplementation(async () => null)
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_missing' }),
    })
    expect(res.status).toBe(401)
  })

  test('401 when key is revoked', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: new Date(),
      kind: 'device',
    }))
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_revoked' }),
    })
    expect(res.status).toBe(401)
  })

  test('401 when key has expired', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: new Date('2020-01-01'),
      kind: 'device',
    }))
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_expired' }),
    })
    expect(res.status).toBe(401)
  })

  test('happy path on device key: bumps lastSeenAt + clamps deviceAppVersion to 32 chars', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
    }))
    const longVersion = 'v'.repeat(80)
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_ok', deviceAppVersion: longVersion }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const data = apiKeyUpdate.mock.calls[0][0].data
    expect(data.lastSeenAt).toBeInstanceOf(Date)
    expect(data.deviceAppVersion).toBe('v'.repeat(32))
  })

  test('non-device key: deviceAppVersion is IGNORED even when supplied', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'user',
    }))
    await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_ok', deviceAppVersion: '1.2.3' }),
    })
    const data = apiKeyUpdate.mock.calls[0][0].data
    expect(data.deviceAppVersion).toBeUndefined()
    expect(data.lastSeenAt).toBeInstanceOf(Date)
  })

  test('DB write failure is swallowed (heartbeat still returns ok)', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
    }))
    apiKeyUpdate.mockImplementation(async () => {
      throw new Error('write conflict')
    })
    const res = await authedApp(null).request('/api/api-keys/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'shogo_sk_ok' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ─── resolveApiKey() ──────────────────────────────────────────────────────

describe('resolveApiKey — used by AI proxy', () => {
  test('returns null when prefix wrong (no DB hit)', async () => {
    apiKeyFindUnique.mockReset()
    const result = await resolveApiKey('sk_openai_xxxx')
    expect(result).toBeNull()
    expect(apiKeyFindUnique).not.toHaveBeenCalled()
  })

  test('returns null when key not found', async () => {
    apiKeyFindUnique.mockImplementation(async () => null)
    expect(await resolveApiKey('shogo_sk_missing')).toBeNull()
  })

  test('returns null when revoked', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: new Date(),
      kind: 'user',
      workspaceId: 'w',
      userId: 'u',
      deviceId: null,
    }))
    expect(await resolveApiKey('shogo_sk_revoked')).toBeNull()
  })

  test('returns null when expired', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: new Date('2020-01-01'),
      kind: 'user',
      workspaceId: 'w',
      userId: 'u',
      deviceId: null,
    }))
    expect(await resolveApiKey('shogo_sk_expired')).toBeNull()
  })

  test('happy path: returns workspaceId, userId, kind, deviceId', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
      workspaceId: 'ws-1',
      userId: 'user-1',
      deviceId: 'desk-7',
    }))
    expect(await resolveApiKey('shogo_sk_ok')).toEqual({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'device',
      deviceId: 'desk-7',
    })
  })

  test('user-kind key: fires lastUsedAt update but NOT lastSeenAt/deviceAppVersion', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'user',
      workspaceId: 'ws-1',
      userId: 'user-1',
      deviceId: null,
    }))
    await resolveApiKey('shogo_sk_ok', { deviceAppVersion: '99.99.99' })
    // Wait one tick for the fire-and-forget update
    await new Promise((r) => setTimeout(r, 5))
    expect(apiKeyUpdate).toHaveBeenCalledTimes(1)
    const data = apiKeyUpdate.mock.calls[0][0].data
    expect(data.lastUsedAt).toBeInstanceOf(Date)
    expect(data.lastSeenAt).toBeUndefined()
    expect(data.deviceAppVersion).toBeUndefined()
  })

  test('device-kind key: fires lastUsedAt + lastSeenAt + clamped deviceAppVersion', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
      workspaceId: 'ws-1',
      userId: 'user-1',
      deviceId: 'desk-7',
    }))
    await resolveApiKey('shogo_sk_ok', { deviceAppVersion: 'v'.repeat(40) })
    await new Promise((r) => setTimeout(r, 5))
    const data = apiKeyUpdate.mock.calls[0][0].data
    expect(data.lastUsedAt).toBeInstanceOf(Date)
    expect(data.lastSeenAt).toBeInstanceOf(Date)
    expect(data.deviceAppVersion).toBe('v'.repeat(32))
  })

  test('background update failure does NOT propagate (fire-and-forget)', async () => {
    apiKeyFindUnique.mockImplementation(async () => ({
      id: 'k1',
      revokedAt: null,
      expiresAt: null,
      kind: 'device',
      workspaceId: 'ws-1',
      userId: 'user-1',
      deviceId: 'desk-7',
    }))
    apiKeyUpdate.mockImplementation(async () => {
      throw new Error('background hiccup')
    })
    const result = await resolveApiKey('shogo_sk_ok')
    expect(result).toEqual({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'device',
      deviceId: 'desk-7',
    })
  })
})
