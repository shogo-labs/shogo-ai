// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'

/**
 * Unit coverage for `recordUsage`'s internal / non-billable branch — the
 * mechanism that lets server-initiated title generation be recorded for ADMIN
 * cost-tracking WITHOUT billing the user or surfacing in the user's usage log.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-internal-usage.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY

const createdEvents: any[] = []
const consumeUsageCalls: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    usageEvent: {
      create: async (args: any) => {
        createdEvents.push(args.data)
        return args.data
      },
    },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (params: any) => {
    consumeUsageCalls.push(params)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
}))

// No open billing session — force the immediate-charge path for the billable case.
mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  accumulateUsage: () => false,
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'real-user',
}))

const { recordUsage } = await import('../routes/ai-proxy')

const PROXY_JWT_PAYLOAD = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  type: 'ai-proxy' as const,
  authKind: 'proxy-jwt' as const,
  iat: 0,
  exp: 0,
}

beforeEach(() => {
  createdEvents.length = 0
  consumeUsageCalls.length = 0
})

describe('recordUsage — internal (non-billable) title generation', () => {
  test('records a $0 admin event under the given actionType and does NOT bill', async () => {
    await recordUsage(PROXY_JWT_PAYLOAD, 'claude-haiku-4-5', 1000, 200, 0, 0, null, {
      actionType: 'title_generation',
    })

    expect(consumeUsageCalls.length).toBe(0)
    expect(createdEvents.length).toBe(1)
    const ev = createdEvents[0]
    expect(ev.actionType).toBe('title_generation')
    expect(ev.billedUsd).toBe(0)
    expect(ev.workspaceId).toBe('ws-1')
    expect(ev.memberId).toBe('real-user')
    // Real cost is captured for admin tracking even though the user is billed $0.
    expect(typeof ev.rawUsd).toBe('number')
    expect((ev.actionMetadata as any).internal).toBe(true)
    expect((ev.actionMetadata as any).billable).toBe(false)
  })

  test('skips recording entirely when there are zero tokens', async () => {
    await recordUsage(PROXY_JWT_PAYLOAD, 'claude-haiku-4-5', 0, 0, 0, 0, null, {
      actionType: 'title_generation',
    })
    expect(createdEvents.length).toBe(0)
    expect(consumeUsageCalls.length).toBe(0)
  })
})

describe('recordUsage — normal (billable) path is unaffected', () => {
  test('bills via consumeUsage when no internal tag is passed', async () => {
    await recordUsage(PROXY_JWT_PAYLOAD, 'claude-haiku-4-5', 1000, 200, 0, 0, null)
    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionType).toBe('ai_proxy_completion')
  })
})
