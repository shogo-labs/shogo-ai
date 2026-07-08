// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `consumeUsage()` must be a single-writer against `workspace.homeRegion`.
 *
 * `usage_wallets` is a running counter that logical replication's
 * last-update-wins cannot merge, so it is region-local. If two regions both
 * debit the same wallet the copies diverge (incident 2026-07-07: a Pro user
 * migrated India -> EU whose EU wallet was a stale free-tier wallet, hard-
 * blocking with "Usage limit reached"). The fix: when the serving region is
 * NOT the workspace's home region, route the debit to the home region so the
 * wallet has exactly one writer and its `usage_events` (which DO replicate)
 * carry the ledger everywhere.
 *
 *   bun test apps/api/src/__tests__/billing-usage-home-writer.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'

// region.ts reads REGION_ID / REGION_PEERS at import time, so these must be set
// before billing.service (which imports region) is dynamically imported below.
const HOME_REGION = 'eu-frankfurt-1'
const SERVING_REGION = 'us-ashburn-1'
process.env.REGION_ID = SERVING_REGION
process.env.REGION_PEERS = JSON.stringify([
  { id: HOME_REGION, label: 'EU (Frankfurt)', url: 'https://eu.internal.example' },
])
process.env.USAGE_WALLET_HOME_WRITER = 'enforce'

// ── in-memory prisma mock ────────────────────────────────────────────
let walletByWs = new Map<string, any>()
let usageEvents: any[] = []
let walletUpdateCalls = 0
let walletUpsertCalls = 0
let currentHomeRegion = HOME_REGION

const walletStore = {
  findUnique: async (args: any) => walletByWs.get(args.where.workspaceId) ?? null,
  create: async (args: any) => {
    walletByWs.set(args.data.workspaceId, { ...args.data })
    return walletByWs.get(args.data.workspaceId)
  },
  upsert: async (args: any) => {
    walletUpsertCalls++
    const ws = args.where.workspaceId
    const existing = walletByWs.get(ws)
    const merged = existing ? { ...existing, ...args.update } : { ...args.create }
    walletByWs.set(ws, merged)
    return merged
  },
  update: async (args: any) => {
    walletUpdateCalls++
    const ws = args.where.workspaceId
    const existing = walletByWs.get(ws) ?? {}
    walletByWs.set(ws, { ...existing, ...args.data })
    return walletByWs.get(ws)
  },
  updateMany: async () => ({ count: 0 }),
}

const mockPrisma: any = {
  usageWallet: walletStore,
  subscription: {
    findFirst: async () => ({ planId: 'pro', seats: 1, status: 'active' }),
    findMany: async () => [{ planId: 'pro', seats: 1, status: 'active' }],
  },
  workspaceGrant: { findMany: async () => [] },
  usageEvent: {
    create: async (args: any) => {
      const row = { id: `ue-${usageEvents.length + 1}`, ...args.data }
      usageEvents.push(row)
      return row
    },
    findMany: async () => [],
  },
  workspace: {
    // Owned by `currentHomeRegion` (default EU). The serving region is US, so by
    // default this workspace is NOT home here. Tests flip it to prove the
    // same-region path writes locally.
    findUnique: async () => ({ parentWorkspaceId: null, homeRegion: currentHomeRegion }),
    findMany: async () => [],
  },
  $transaction: async (fn: (tx: any) => any) => fn(mockPrisma),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

const billing = await import('../services/billing.service')

const BASE = {
  workspaceId: 'ws-eu-home',
  projectId: null,
  memberId: 'm-1',
  actionType: 'ai_proxy_completion',
  billedUsd: 0.5,
}

function seedWallet(overrides: Record<string, unknown> = {}) {
  walletByWs.set('ws-eu-home', {
    workspaceId: 'ws-eu-home',
    monthlyIncludedUsd: 20,
    monthlyIncludedAllocationUsd: 20,
    dailyIncludedUsd: 0,
    dailyUsedThisMonthUsd: 0,
    fiveHourWindowStart: null,
    fiveHourUsedUsd: 0,
    weeklyWindowStart: null,
    weeklyUsedUsd: 0,
    overageEnabled: true,
    overageHardLimitUsd: null,
    overageAccumulatedUsd: 0,
    overageBilledUsd: 0,
    lastMonthlyReset: new Date(),
    lastDailyReset: new Date(),
    anniversaryDay: 1,
    alertsSentThisPeriod: {},
    ...overrides,
  })
}

const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; body: any }> = []

beforeEach(() => {
  walletByWs = new Map()
  usageEvents = []
  walletUpdateCalls = 0
  walletUpsertCalls = 0
  fetchCalls = []
  currentHomeRegion = HOME_REGION
  process.env.USAGE_WALLET_HOME_WRITER = 'enforce'
  seedWallet()
  // Stand in for the home region's /api/internal/billing/consume endpoint.
  globalThis.fetch = (async (url: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null
    fetchCalls.push({ url: String(url), body })
    return new Response(
      JSON.stringify({ success: true, remainingIncludedUsd: 19.5, overageChargedUsd: 0, source: 'window' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('consumeUsage single-writer routing', () => {
  test('routes the debit to the home region and does NOT mutate the local wallet', async () => {
    const res = await billing.consumeUsage({ ...BASE })

    // The wallet debit must happen in the home region, not locally.
    expect(walletUpdateCalls).toBe(0)
    expect(walletUpsertCalls).toBe(0)
    expect(walletByWs.get('ws-eu-home').fiveHourUsedUsd).toBe(0)
    expect(usageEvents.length).toBe(0)

    // It must have called the home region's internal consume endpoint.
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toContain('https://eu.internal.example')
    expect(fetchCalls[0].url).toContain('/api/internal/billing/consume')
    expect(fetchCalls[0].body.workspaceId).toBe('ws-eu-home')
    expect(fetchCalls[0].body.billedUsd).toBe(0.5)

    // And it must surface the home region's authoritative result.
    expect(res.success).toBe(true)
    expect(res.remainingIncludedUsd).toBe(19.5)
  })

  test('writes locally (no RPC) when the serving region IS the home region', async () => {
    currentHomeRegion = SERVING_REGION // this region owns the wallet
    const res = await billing.consumeUsage({ ...BASE })

    expect(fetchCalls.length).toBe(0)
    expect(walletUpdateCalls).toBe(1)
    expect(usageEvents.length).toBe(1)
    expect(res.success).toBe(true)
  })

  test('off mode always writes locally, even in a non-home region', async () => {
    process.env.USAGE_WALLET_HOME_WRITER = 'off'
    const res = await billing.consumeUsage({ ...BASE })

    expect(fetchCalls.length).toBe(0)
    expect(walletUpdateCalls).toBe(1)
    expect(usageEvents.length).toBe(1)
    expect(res.success).toBe(true)
  })

  test('shadow mode writes locally (no RPC) in a non-home region', async () => {
    process.env.USAGE_WALLET_HOME_WRITER = 'shadow'
    const res = await billing.consumeUsage({ ...BASE })

    expect(fetchCalls.length).toBe(0)
    expect(walletUpdateCalls).toBe(1)
    expect(usageEvents.length).toBe(1)
    expect(res.success).toBe(true)
  })

  test('enforce falls back to a local write when the home region RPC fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('peer unreachable')
    }) as any
    const res = await billing.consumeUsage({ ...BASE })

    // Usage is never lost: the debit lands locally when the peer is down.
    expect(walletUpdateCalls).toBe(1)
    expect(usageEvents.length).toBe(1)
    expect(res.success).toBe(true)
  })
})
