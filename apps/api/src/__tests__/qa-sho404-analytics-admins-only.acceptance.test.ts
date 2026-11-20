// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-404, workspace analytics are owner/admin only.
 *
 * The card's own tests mock `lib/prisma`, so the role matrix is asserted
 * against hand-built membership rows. This file closes that gap and runs the
 * real routes against a real database (desktop SQLite migrations by default,
 * Postgres when `CHANNELS_TEST_PG_URL` is set):
 *
 *   1. Every `/workspaces/:id/analytics/*`, `/projects/:id/analytics/*` and
 *      `/workspaces/:id/cost-analytics/*` GET answers a member, a viewer and a
 *      non-member with 403 `analytics_admin_only` — and never reaches the
 *      service.
 *   2. An owner and an admin get the data (200), not the gate.
 *   3. `/me/analytics/*` still answers a member with their own numbers.
 *   4. Cost-analytics writes still need `workspace.settings:manage`, so a
 *      member is refused there for the settings reason, not the analytics one.
 *   5. The route list is read from the router source, so a new analytics GET
 *      that ships without the guard fails here.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from './helpers/channels-test-db'

let currentUserId = ''
setupChannelsTestDb()

// The auth middleware is the only thing mocked: everything below it — authz,
// membership rows, the route handlers — is the real code.
const { mock } = await import('bun:test')
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: currentUserId })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

const { prisma } = await import('../lib/prisma')
const { scopedAnalyticsRoutes } = await import('../routes/scoped-analytics')
const { costAnalyticsRoutes } = await import('../routes/cost-analytics')

const db = prisma as any

let seeded: SeededWorkspace
let admin = ''

beforeAll(async () => {
  seeded = await seedWorkspace(db)
  const suffix = crypto.randomUUID().slice(0, 8)
  const adminUser = await db.user.create({
    data: { name: 'admin', email: `admin-${suffix}@example.com` },
  })
  admin = adminUser.id
  await db.member.create({ data: { userId: admin, workspaceId: seeded.workspaceId, role: 'admin' } })
}, 120_000)

// ─── route discovery ──────────────────────────────────────────────────

const ROUTES_DIR = join(import.meta.dir, '..', 'routes')

function analyticsGetPaths(file: string): string[] {
  const source = readFileSync(join(ROUTES_DIR, file), 'utf8')
  const paths: string[] = []
  const re = /router\.get\(\s*'([^']+)'/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const path = m[1]
    if (path.startsWith('/me/')) continue
    if (!path.includes('/analytics/') && !path.includes('/cost-analytics/')) continue
    paths.push(path)
  }
  return paths
}

const workspacePaths = [
  ...analyticsGetPaths('scoped-analytics.ts'),
  ...analyticsGetPaths('cost-analytics.ts'),
]

function concrete(path: string): string {
  return path
    .replace(':workspaceId', seeded.workspaceId)
    .replace(':projectId', seeded.projectId)
    .replace(':experimentId', 'exp_missing')
    .replace(':alertId', 'alert_missing')
    .replace(':id', 'id_missing')
    .replace(':agentType', 'planner')
}

async function get(path: string) {
  const url = `http://test${concrete(path)}`
  const router = path.includes('/cost-analytics/') ? costAnalyticsRoutes() : scopedAnalyticsRoutes()
  const res = await router.fetch(new Request(url))
  const body: any = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// ─── the gate ─────────────────────────────────────────────────────────

describe('every workspace analytics GET is owner/admin only', () => {
  test('the route list is not empty (the discovery regex still matches)', () => {
    expect(workspacePaths.length).toBeGreaterThan(20)
  })

  for (const path of workspacePaths) {
    test(`member is refused: GET ${path}`, async () => {
      currentUserId = seeded.member
      const { status, body } = await get(path)
      expect(status).toBe(403)
      expect(body.error?.code).toBe('analytics_admin_only')
    })

    test(`viewer is refused: GET ${path}`, async () => {
      currentUserId = seeded.viewer
      const { status, body } = await get(path)
      expect(status).toBe(403)
      expect(body.error?.code).toBe('analytics_admin_only')
    })

    test(`a non-member is refused: GET ${path}`, async () => {
      currentUserId = seeded.outsider
      const { status, body } = await get(path)
      expect(status).toBe(403)
      // A project route resolves the project first, so a non-member is stopped
      // there; a workspace route has nothing to resolve and answers with the
      // analytics gate.
      expect(body.error?.code).toBe(
        path.startsWith('/projects/') ? 'forbidden' : 'analytics_admin_only',
      )
    })

    test(`owner gets the data: GET ${path}`, async () => {
      currentUserId = seeded.owner
      const { status, body } = await get(path)
      expect(body.error?.code).not.toBe('analytics_admin_only')
      // A route that names a resource answers 404 for the fixture's missing id;
      // that is past the gate, which is what this asserts.
      expect([200, 404]).toContain(status)
    })

    test(`admin gets the data: GET ${path}`, async () => {
      currentUserId = admin
      const { status, body } = await get(path)
      expect(body.error?.code).not.toBe('analytics_admin_only')
      expect([200, 404]).toContain(status)
    })
  }
})

// ─── the personal surface stays open ──────────────────────────────────

describe('/me/analytics/* still answers a member', () => {
  for (const path of [
    '/me/analytics/overview',
    '/me/analytics/usage-log',
    '/me/analytics/usage-summary',
    '/me/analytics/engagement',
  ]) {
    test(`member gets their own data: GET ${path}`, async () => {
      currentUserId = seeded.member
      const res = await scopedAnalyticsRoutes().fetch(new Request(`http://test${path}`))
      expect(res.status).toBe(200)
    })
  }
})

// ─── writes keep the settings gate ────────────────────────────────────

describe('cost-analytics writes still need workspace.settings:manage', () => {
  const writes: Array<[string, string]> = [
    ['POST', `/workspaces/${'WS'}/cost-analytics/budget-alerts`],
    ['PATCH', `/workspaces/${'WS'}/cost-analytics/budget-alerts/alert_missing`],
    ['DELETE', `/workspaces/${'WS'}/cost-analytics/budget-alerts/alert_missing`],
    ['POST', `/workspaces/${'WS'}/cost-analytics/experiments`],
    ['POST', `/workspaces/${'WS'}/cost-analytics/experiments/exp_missing/stop`],
    ['POST', `/workspaces/${'WS'}/cost-analytics/experiments/shadow`],
    ['POST', `/workspaces/${'WS'}/cost-analytics/agent-eval-sets`],
    ['DELETE', `/workspaces/${'WS'}/cost-analytics/agent-eval-sets/id_missing`],
    ['POST', `/workspaces/${'WS'}/cost-analytics/subagent-overrides`],
    ['DELETE', `/workspaces/${'WS'}/cost-analytics/subagent-overrides/planner`],
  ]

  for (const [method, template] of writes) {
    test(`a member is refused for the settings reason: ${method} ${template}`, async () => {
      currentUserId = seeded.member
      const path = template.replace('WS', seeded.workspaceId)
      const res = await costAnalyticsRoutes().fetch(
        new Request(`http://test${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'DELETE' ? undefined : '{}',
        }),
      )
      expect(res.status).toBe(403)
      const body: any = await res.json().catch(() => ({}))
      // Not the analytics gate: writes are gated on settings:manage.
      expect(body.error?.code).not.toBe('analytics_admin_only')
    })
  }
})
