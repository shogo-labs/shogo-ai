// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/admin/creators — exercises the real getCreatorStats() aggregation
 * (marketplace metrics joined to per-creator platform spend) through the
 * router, authorized via a creators:read partial admin.
 *
 * Run: bun test apps/api/src/__tests__/admin-creators-route.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const creators = [
  {
    userId: 'uA',
    displayName: 'Alice',
    creatorTier: 'rising',
    reputationScore: 120,
    verified: true,
    totalAgentsPublished: 4,
    totalInstalls: 10,
    averageAgentRating: 4.5,
    totalVersionsShipped: 9,
    followerCount: 30,
    totalEarningsInCents: 5000,
    pendingPayoutInCents: 1500,
    totalPaidOutInCents: 3500,
    user: { id: 'uA', name: 'Alice A', email: 'alice@example.com' },
  },
  {
    userId: 'uB',
    displayName: 'Bob',
    creatorTier: 'newcomer',
    reputationScore: 5,
    verified: false,
    totalAgentsPublished: 1,
    totalInstalls: 3,
    averageAgentRating: 0,
    totalVersionsShipped: 1,
    followerCount: 0,
    totalEarningsInCents: 0,
    pendingPayoutInCents: 0,
    totalPaidOutInCents: 0,
    user: { id: 'uB', name: 'Bob B', email: 'bob@example.com' },
  },
]

const members = [
  { id: 'm1', userId: 'uA' },
  { id: 'm2', userId: 'uA' },
  { id: 'm3', userId: 'uB' },
]

// Only Alice (m1, m2) has usage; Bob (m3) has none.
const events = [
  { memberId: 'm1', billedUsd: 1.5 },
  { memberId: 'm2', billedUsd: 2.0 },
]

const mockPrisma = {
  user: {
    findUnique: mock(async () => ({ role: 'user', adminScopes: ['creators:read'] })),
  },
  creatorProfile: {
    findMany: mock(async () => creators),
  },
  member: {
    findMany: mock(async () => members),
  },
  usageEvent: {
    findMany: mock(async () => events),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: 'viewer', isAuthenticated: true })
    await next()
  },
  requireAuth: async (_c: any, next: any) => {
    await next()
  },
}))

const { adminRoutes } = await import('../routes/admin')

function createApp() {
  const app = new Hono()
  app.route('/api/admin', adminRoutes())
  return app
}

describe('GET /api/admin/creators', () => {
  test('joins marketplace stats with per-creator platform spend', async () => {
    const app = createApp()
    const res = await app.request('/api/admin/creators')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(2)

    const alice = body.data.find((c: any) => c.userId === 'uA')
    expect(alice.displayName).toBe('Alice')
    expect(alice.name).toBe('Alice A')
    expect(alice.email).toBe('alice@example.com')
    expect(alice.totalInstalls).toBe(10)
    expect(alice.totalEarningsUsd).toBe(50)
    expect(alice.pendingPayoutUsd).toBe(15)
    expect(alice.totalPaidOutUsd).toBe(35)
    // 1.5 + 2.0 across Alice's two members
    expect(alice.spendUsd).toBeCloseTo(3.5, 5)
  })

  test('reports zero spend for a creator with no usage events', async () => {
    const app = createApp()
    const res = await app.request('/api/admin/creators')
    const body = (await res.json()) as any
    const bob = body.data.find((c: any) => c.userId === 'uB')
    expect(bob.spendUsd).toBe(0)
    expect(bob.totalEarningsUsd).toBe(0)
  })
})
