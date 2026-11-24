// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AI Proxy — `GET /api/ai/v1/models` resolves the plan entitlement once (PERF-31).
 *
 * The model list is built with `Promise.all`, so every model starts its
 * accessibility check before the first entitlement lookup settles. Memoising the
 * *resolved value* (`advancedAccess ??= await …`) therefore missed every
 * concurrent caller and issued one `hasAdvancedModelAccess` query per model — 13
 * per call, ~584k subscription lookups a day, the #1 query by total time in both
 * regions. The in-flight promise is memoised instead.
 *
 *   bun test apps/api/src/__tests__/perf-31-models-entitlement-lookup.test.ts
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'perf-31-test-secret'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'perf-31-better-auth-secret'
// A provider counts as configured only when its key is present, and the
// entitlement is consulted only for a configured provider's models.
process.env.ANTHROPIC_API_KEY = 'sk-ant-perf-31-test'
process.env.OPENAI_API_KEY = 'sk-openai-perf-31-test'
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
delete process.env.AI_MODE

/** Plan entitlement the billing seam answers with. */
let advancedAccess = true
/** How many times the entitlement was resolved for one request. */
let entitlementLookups = 0

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    platformSetting: { findUnique: async () => null, findMany: async () => [] },
    localConfig: { findUnique: async () => null },
    modelDefinition: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    workspaceModelVisibility: { findMany: async () => [] },
    subscription: { findFirst: async () => null },
    workspaceGrant: { findMany: async () => [] },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  ensureSystemWorkspace: async () => {},
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => advancedAccess,
  checkUsageBalance: async () => ({ ok: true, remainingIncludedUsd: 100 }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'usage limit reached' }),
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
}))

const billingRuntime = await import('../services/billing-runtime')
mock.module('../services/billing-runtime', () => ({
  ...billingRuntime,
  // Counts every resolution, and yields so the lookups genuinely overlap the way
  // they do in production, where each one is a Postgres round-trip.
  hasAdvancedModelAccess: async () => {
    entitlementLookups += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return advancedAccess
  },
}))

mock.module('../lib/proxy-capture', () => ({
  beginCapture: async () => null,
  updateTurnFeedback: async () => {},
  markProjectTurnsReverted: async () => {},
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({ getProjectUser: () => 'user-1' }))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

let TOKEN = ''
let app: any

beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
  app = new Hono()
  app.route('/api', aiProxyRoutes())
})

beforeEach(() => {
  advancedAccess = true
  entitlementLookups = 0
})

async function listModels() {
  const res = await app.fetch(new Request('http://x/api/ai/v1/models', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }))
  return { res, body: await res.json() as any }
}

describe('GET /api/ai/v1/models — plan entitlement (PERF-31)', () => {
  test('resolves the entitlement once for the whole list', async () => {
    const { res, body } = await listModels()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(1)
    // The fixture must actually exercise the path, otherwise the assertion below
    // would pass without testing anything.
    expect(entitlementLookups).toBeGreaterThanOrEqual(1)
    expect(entitlementLookups).toBe(1)
  })

  test('still reports advanced models unavailable without the entitlement', async () => {
    advancedAccess = false
    const { res, body } = await listModels()

    expect(res.status).toBe(200)
    expect(entitlementLookups).toBe(1)
    expect(body.data.some((model: any) => model.available === false)).toBe(true)
  })
})
