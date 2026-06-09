// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Supplementary tests for `src/routes/admin.ts` — exclusively exercises
 * the catch handlers that the happy-path test (`admin-routes.expanded`)
 * leaves uncovered. Every admin endpoint follows the pattern:
 *
 *     try {
 *       const data = await analytics.getX(...)
 *       return c.json({ ok: true, data })
 *     } catch (error: any) {
 *       console.error('[Admin] X error:', error)
 *       return c.json({ error: { code, message: error.message } }, 500)
 *     }
 *
 * `admin-routes.expanded.test.ts` exercises the `ok:true` branch of
 * every endpoint. This file forces the underlying service / DB to
 * throw so the `catch` branch + the typed `error.code` are pinned.
 *
 * Mocks mirror the existing test's surface but flip every analytics
 * mock to a throwing implementation. The two files don't co-mock the
 * same symbol with conflicting factories — bun's `mock.module` is
 * last-write-wins, and we install our throwing factories BEFORE the
 * adminRoutes import so they apply to OUR `await import()`.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Auth + super-admin pass-through ──────────────────────────────────────

mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-1' })
    c.set('auth', { userId: 'user-1', isAuthenticated: true })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

mock.module('../middleware/super-admin', () => ({
  requireSuperAdmin: async (_c: any, next: any) => next(),
}))

// ─── Throwing analytics service ───────────────────────────────────────────
// Every analytics method throws — exercises every `catch` branch in the
// 16 analytics endpoints + the deriveSourceTag downstream code path.
const ERROR_MSG = 'simulated analytics outage'
function thrower() {
  return mock(async () => {
    throw new Error(ERROR_MSG)
  })
}
mock.module('../services/analytics.service', () => ({
  getOverviewStats: thrower(),
  getGrowthTimeSeries: thrower(),
  getUsageAnalytics: thrower(),
  getActiveUsers: thrower(),
  getChatAnalytics: thrower(),
  getProjectAnalytics: thrower(),
  getBillingAnalytics: thrower(),
  getUsageLog: thrower(),
  getUsageSummary: thrower(),
  getUserFunnel: thrower(),
  getUserActivityTable: thrower(),
  getTemplateEngagement: thrower(),
  getSourceBreakdown: thrower(),
  deriveSourceTag: mock(() => 'google:cpc'),
}))

// ─── Heartbeat / warm-pool / digest — fail by default ─────────────────────

const schedulerStub = {
  paused: false,
  getStats: mock(() => {
    throw new Error('scheduler getStats explosion')
  }),
  getBreakerSnapshot: mock(() => []),
  pause: mock(() => {}),
  resume: mock(() => {}),
  isPaused: mock(() => false),
  triggerNow: mock(async () => {
    throw new Error('trigger explosion')
  }),
  clearFailures: mock(() => {}),
}

let getActiveHeartbeatSchedulerBehavior: 'normal' | 'throw' = 'normal'
mock.module('../lib/admin-heartbeat', () => ({
  getActiveHeartbeatScheduler: mock(async () => {
    if (getActiveHeartbeatSchedulerBehavior === 'throw') {
      throw new Error('admin-heartbeat module exploded')
    }
    return schedulerStub
  }),
  getSchedulerKind: mock(() => 'local'),
}))

mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: mock(() => ({
    getExtendedStatus: mock(async () => {
      throw new Error('warm-pool exploded')
    }),
  })),
}))

mock.module('../lib/analytics-digest-collector', () => ({
  generateDigest: mock(async () => {
    throw new Error('digest gen exploded')
  }),
}))

// ─── Prisma throwing ──────────────────────────────────────────────────────

const prismaThrower = (label: string) =>
  mock(async () => {
    throw new Error(`prisma ${label} exploded`)
  })

const prisma = {
  // Must SUCCEED (not throw): the real requireAdminScope resolves admin access
  // via getAdminAccess before the handler runs. A super_admin passes every
  // scope gate so the request reaches the handler's throwing analytics call.
  user: {
    findUnique: mock(async () => ({ role: 'super_admin', adminScopes: [] as string[] })),
  },
  infraSnapshot: {
    findFirst: prismaThrower('infraSnapshot.findFirst'),
    findMany: prismaThrower('infraSnapshot.findMany'),
  },
  analyticsDigest: {
    findFirst: prismaThrower('analyticsDigest.findFirst'),
    findMany: prismaThrower('analyticsDigest.findMany'),
  },
  agentConfig: {
    count: prismaThrower('agentConfig.count'),
    findUnique: prismaThrower('agentConfig.findUnique'),
    findMany: prismaThrower('agentConfig.findMany'),
    update: prismaThrower('agentConfig.update'),
  },
  project: {
    findMany: prismaThrower('project.findMany'),
  },
  signupAttribution: {
    upsert: prismaThrower('signupAttribution.upsert'),
  },
}

mock.module('../lib/prisma', () => ({
  prisma,
  // Re-export enums so any sibling test files that load alongside
  // don't blow up on missing exports (defensive — see the broader
  // cross-file-mock-pollution discussion in prior commits).
  SubscriptionStatus: {
    active: 'active', past_due: 'past_due', canceled: 'canceled',
    incomplete: 'incomplete', incomplete_expired: 'incomplete_expired',
    trialing: 'trialing', unpaid: 'unpaid', paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── Load route under test ────────────────────────────────────────────────

const { adminRoutes, userAttributionRoute } = await import('../routes/admin')

const consoleErrorSpy = mock(() => {})
const origConsoleError = console.error
beforeEach(() => {
  getActiveHeartbeatSchedulerBehavior = 'normal'
  console.error = consoleErrorSpy as any
  ;(consoleErrorSpy as any).mockClear?.()
})

async function expect500(app: any, path: string, expectedCode: string, opts?: { method?: string; body?: string }) {
  const init: RequestInit = { method: opts?.method ?? 'GET' }
  if (opts?.body) {
    init.body = opts.body
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body.error.code).toBe(expectedCode)
  // Most catch handlers surface `error.message` of the thrown error.
  expect(typeof body.error.message).toBe('string')
}

// ─── Analytics endpoints — every catch ────────────────────────────────────

describe('analytics endpoints — catch handlers', () => {
  test('GET /analytics/overview → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/overview', 'analytics_failed')
  })
  test('GET /analytics/growth → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/growth?period=7d', 'analytics_failed')
  })
  test('GET /analytics/usage → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/usage', 'analytics_failed')
  })
  test('GET /analytics/active-users → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/active-users', 'analytics_failed')
  })
  test('GET /analytics/chat → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/chat', 'analytics_failed')
  })
  test('GET /analytics/projects → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/projects', 'analytics_failed')
  })
  test('GET /analytics/billing → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/billing', 'analytics_failed')
  })
  test('GET /analytics/usage-log → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/usage-log', 'analytics_failed')
  })
  test('GET /analytics/usage-summary → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/usage-summary', 'analytics_failed')
  })
  test('GET /analytics/infra-current → 500 infra_failed', async () => {
    // Pulls from prisma.infraSnapshot; uses the typed `infra_failed` code.
    await expect500(adminRoutes(), '/analytics/infra-current', 'infra_failed')
  })
  test('GET /analytics/infra-history → 500 infra_failed', async () => {
    await expect500(adminRoutes(), '/analytics/infra-history', 'infra_failed')
  })
  test('GET /analytics/funnel → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/funnel', 'analytics_failed')
  })
  test('GET /analytics/user-activity → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/user-activity', 'analytics_failed')
  })
  test('GET /analytics/template-engagement → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/template-engagement', 'analytics_failed')
  })
  test('GET /analytics/source-breakdown → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/source-breakdown', 'analytics_failed')
  })
  test('GET /analytics/ai-digest → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/ai-digest', 'analytics_failed')
  })
  test('GET /analytics/ai-digest/list → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/ai-digest/list', 'analytics_failed')
  })
  test('POST /analytics/ai-digest/generate → 500 analytics_failed', async () => {
    await expect500(adminRoutes(), '/analytics/ai-digest/generate', 'analytics_failed', {
      method: 'POST',
    })
  })
})

// ─── Logging side-effect pin ──────────────────────────────────────────────

describe('analytics endpoints — error logging side-effect', () => {
  test('each catch invokes console.error with the [Admin] prefix and the underlying error', async () => {
    ;(consoleErrorSpy as any).mockClear?.()
    await adminRoutes().request('/analytics/overview')
    expect((consoleErrorSpy as any).mock.calls.length).toBeGreaterThan(0)
    const out = (consoleErrorSpy as any).mock.calls
      .map((c: any[]) => c.map((x: any) => (x instanceof Error ? x.message : String(x))).join(' '))
      .join('\n')
    expect(out).toContain('[Admin]')
    expect(out).toContain(ERROR_MSG)
  })
})

// ─── Heartbeats endpoints — catch handlers ────────────────────────────────

describe('heartbeats endpoints — catch handlers', () => {
  test('GET /heartbeats/overview → 500 heartbeats_failed when scheduler.getStats throws', async () => {
    await expect500(adminRoutes(), '/heartbeats/overview', 'heartbeats_failed')
  })

  test('GET /heartbeats → 500 heartbeats_failed when prisma.agentConfig.count throws', async () => {
    await expect500(adminRoutes(), '/heartbeats', 'heartbeats_failed')
  })

  test('POST /heartbeats/scheduler/pause → 500 heartbeats_failed', async () => {
    getActiveHeartbeatSchedulerBehavior = 'throw'
    await expect500(adminRoutes(), '/heartbeats/scheduler/pause', 'heartbeats_failed', {
      method: 'POST',
    })
  })

  test('POST /heartbeats/scheduler/resume → 500 heartbeats_failed', async () => {
    getActiveHeartbeatSchedulerBehavior = 'throw'
    await expect500(adminRoutes(), '/heartbeats/scheduler/resume', 'heartbeats_failed', {
      method: 'POST',
    })
  })

  test('POST /heartbeats/projects/:projectId/trigger → 500 heartbeats_failed', async () => {
    await expect500(
      adminRoutes(),
      '/heartbeats/projects/proj-1/trigger',
      'heartbeats_failed',
      { method: 'POST' },
    )
  })

  test('PATCH /heartbeats/projects/:projectId → 500 heartbeats_failed', async () => {
    await expect500(
      adminRoutes(),
      '/heartbeats/projects/proj-1',
      'heartbeats_failed',
      {
        method: 'PATCH',
        body: JSON.stringify({ heartbeatEnabled: true }),
      },
    )
  })

  test('POST /heartbeats/projects/:projectId/clear-failures → 500 heartbeats_failed', async () => {
    getActiveHeartbeatSchedulerBehavior = 'throw'
    await expect500(
      adminRoutes(),
      '/heartbeats/projects/proj-1/clear-failures',
      'heartbeats_failed',
      { method: 'POST' },
    )
  })
})

// ─── userAttributionRoute — catch ─────────────────────────────────────────

describe('userAttributionRoute — catch handler', () => {
  test('POST /users/me/attribution → 500 when upsert throws', async () => {
    const app = userAttributionRoute()
    const res = await app.request('/users/me/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'google', medium: 'cpc' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('attribution_failed')
  })
})

// ─── teardown ─────────────────────────────────────────────────────────────

import { afterAll } from 'bun:test'
afterAll(() => {
  console.error = origConsoleError
})
