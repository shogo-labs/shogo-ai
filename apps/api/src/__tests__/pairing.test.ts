// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QR Pairing API Tests (Phase 4)
 *
 * Run: bun test apps/api/src/__tests__/pairing.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

const mockPairingCode = {
  id: 'pair-1',
  workspaceId: 'ws-1',
  createdByUserId: 'user-1',
  code: '123456',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  usedAt: null as Date | null,
  apiKeyId: null as string | null,
  publicKey: null as string | null,
  createdAt: new Date(),
}

const mockPrisma = {
  member: {
    findFirst: mock(() => Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' })),
  },
  pairingCode: {
    create: mock(() => Promise.resolve({ ...mockPairingCode })),
    findUnique: mock(() => Promise.resolve({ ...mockPairingCode })),
    update: mock(() => Promise.resolve({ ...mockPairingCode, usedAt: new Date() })),
  },
  apiKey: {
    create: mock(() => Promise.resolve({ id: 'key-1', name: 'Paired device' })),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

const { pairingRoutes } = await import('../routes/pairing')

const testUser = { id: 'user-1', userId: 'user-1', email: 'test@test.com' }

function createTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', testUser)
    await next()
  })
  app.route('/api', pairingRoutes())
  return app
}

describe('POST /api/pairing/initiate', () => {
  beforeEach(() => {
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    mockPrisma.pairingCode.create.mockReset()
    mockPrisma.pairingCode.create.mockImplementation(() => Promise.resolve({ ...mockPairingCode }))
  })

  test('creates a pairing code', async () => {
    const app = createTestApp()
    const res = await app.request('/api/pairing/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.code).toBe('123456')
    expect(data.expiresAt).toBeTruthy()
  })

  test('accepts optional publicKey for E2E', async () => {
    const app = createTestApp()
    const res = await app.request('/api/pairing/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', publicKey: 'base64key==' }),
    })
    expect(res.status).toBe(200)
    const createCall = mockPrisma.pairingCode.create.mock.calls[0][0]
    expect(createCall.data.publicKey).toBe('base64key==')
  })

  test('returns 400 without workspaceId', async () => {
    const app = createTestApp()
    const res = await app.request('/api/pairing/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('returns 403 for non-member', async () => {
    mockPrisma.member.findFirst.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/pairing/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-other' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/pairing/complete', () => {
  beforeEach(() => {
    mockPrisma.pairingCode.findUnique.mockReset()
    mockPrisma.pairingCode.findUnique.mockImplementation(() => Promise.resolve({ ...mockPairingCode }))
    mockPrisma.member.findFirst.mockReset()
    mockPrisma.member.findFirst.mockImplementation(() =>
      Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    mockPrisma.apiKey.create.mockReset()
    mockPrisma.apiKey.create.mockImplementation(() => Promise.resolve({ id: 'key-1' }))
    mockPrisma.pairingCode.update.mockReset()
    mockPrisma.pairingCode.update.mockImplementation(() => Promise.resolve({ ...mockPairingCode, usedAt: new Date() }))
  })

  test('completes pairing and returns API key', async () => {
    const app = createTestApp()
    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.apiKey).toBeTruthy()
    expect(data.apiKey.startsWith('shogo_sk_')).toBe(true)
    expect(data.workspaceId).toBe('ws-1')
    expect(mockPrisma.apiKey.create).toHaveBeenCalled()
    expect(mockPrisma.pairingCode.update).toHaveBeenCalled()
  })

  test('returns peerPublicKey when desktop provided one', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() =>
      Promise.resolve({ ...mockPairingCode, publicKey: 'desktopPubKey==' }),
    )
    const app = createTestApp()
    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    const data = await res.json()
    expect(data.peerPublicKey).toBe('desktopPubKey==')
  })

  test('returns 400 for invalid code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999999' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for already-used code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() =>
      Promise.resolve({ ...mockPairingCode, usedAt: new Date() }),
    )
    const app = createTestApp()
    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('code_used')
  })

  test('returns 400 for expired code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() =>
      Promise.resolve({ ...mockPairingCode, expiresAt: new Date(Date.now() - 1000) }),
    )
    const app = createTestApp()
    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('code_expired')
  })

  test('completes pairing without session auth using createdByUserId', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', { isAuthenticated: false })
      await next()
    })
    app.route('/api', pairingRoutes())

    const res = await app.request('/api/pairing/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.apiKey).toBeTruthy()
    expect(data.apiKey.startsWith('shogo_sk_')).toBe(true)
    expect(data.workspaceId).toBe('ws-1')

    const createCall = mockPrisma.apiKey.create.mock.calls.at(-1)?.[0]
    expect(createCall.data.userId).toBe('user-1')
  })
})

describe('GET /api/pairing/:code/status', () => {
  beforeEach(() => {
    mockPrisma.pairingCode.findUnique.mockReset()
  })

  test('returns pending for unused code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() => Promise.resolve({ ...mockPairingCode }))
    const app = createTestApp()
    const res = await app.request('/api/pairing/123456/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('pending')
  })

  test('returns completed for used code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() =>
      Promise.resolve({ ...mockPairingCode, usedAt: new Date() }),
    )
    const app = createTestApp()
    const res = await app.request('/api/pairing/123456/status')
    const data = await res.json()
    expect(data.status).toBe('completed')
  })

  test('returns expired for expired unused code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() =>
      Promise.resolve({ ...mockPairingCode, expiresAt: new Date(Date.now() - 1000), usedAt: null }),
    )
    const app = createTestApp()
    const res = await app.request('/api/pairing/123456/status')
    const data = await res.json()
    expect(data.status).toBe('expired')
  })

  test('returns 404 for unknown code', async () => {
    mockPrisma.pairingCode.findUnique.mockImplementation(() => Promise.resolve(null))
    const app = createTestApp()
    const res = await app.request('/api/pairing/000000/status')
    expect(res.status).toBe(404)
  })
})
