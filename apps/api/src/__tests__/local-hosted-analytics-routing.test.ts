// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-590 §C — a hosted workspace's Analytics is read from the cloud, on the
 * desktop too.
 *
 * The cloud is the meter for a paired desktop's forwarded calls, so its ledger
 * is the one answer both surfaces must show. Local-only workspaces (and every
 * workspace on an unpaired or BYOK desktop) keep reading local rows exactly as
 * before — including the `hostInstanceId: null` case, which is a workspace whose
 * compute is the cloud's own.
 *
 *   bun test apps/api/src/__tests__/local-hosted-analytics-routing.test.ts
 */

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const CLOUD = 'http://cloud.test'
process.env.SHOGO_CLOUD_URL = CLOUD
process.env.SHOGO_API_KEY = 'shogo_sk_test_device_key'

/** `hostInstanceId` per workspace id; a missing row means "no such workspace". */
let workspaces: Record<string, string | null> = {}

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      workspace: {
        findUnique: async ({ where }: any) => {
          if (!(where.id in workspaces)) return null
          return { id: where.id, hostInstanceId: workspaces[where.id] }
        },
      },
      localConfig: { findUnique: async () => null },
    },
  }),
)

const fetchCalls: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (url: any) => {
  fetchCalls.push(String(url))
  return new Response(JSON.stringify({ source: 'cloud' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as any

afterAll(() => {
  globalThis.fetch = originalFetch
})

const { Hono } = await import('hono')
const { HOSTED_ANALYTICS_PATHS, hostedAnalyticsUpstream } = await import('../routes/local-hosted-analytics')

/** The same wiring `create-local-app.ts` does: the gate, then the local routes. */
function app() {
  const router = new Hono()
  for (const path of HOSTED_ANALYTICS_PATHS) router.use(path, hostedAnalyticsUpstream())
  router.get('/api/workspaces/:workspaceId/analytics/dashboard', (c) => c.json({ source: 'local' }))
  router.get('/api/workspaces/:workspaceId/analytics/usage-log.csv', (c) => c.text('source,local'))
  router.get('/api/workspaces/:workspaceId/cost-analytics/trends', (c) => c.json({ source: 'local' }))
  return router
}

async function get(path: string) {
  const res = await app().fetch(new Request(`http://localhost${path}`))
  const contentType = res.headers.get('content-type') ?? ''
  return { res, body: contentType.includes('json') ? await res.json() : await res.text() }
}

function paired() {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_test_device_key'
  delete process.env.AI_MODE
}

beforeEach(() => {
  fetchCalls.length = 0
  workspaces = {
    'ws-hosted': 'inst-macbook',
    'ws-cloud-compute': null,
  }
  paired()
})

describe('SHO-590 §C: a hosted workspace reads the cloud ledger', () => {
  test('the dashboard is answered by the cloud', async () => {
    const { res, body } = await get('/api/workspaces/ws-hosted/analytics/dashboard?period=7d')
    expect(res.status).toBe(200)
    expect(body).toEqual({ source: 'cloud' })
    expect(fetchCalls).toEqual([`${CLOUD}/api/workspaces/ws-hosted/analytics/dashboard?period=7d`])
  })

  test('the usage-log CSV too — it is the same ledger', async () => {
    const { res } = await get('/api/workspaces/ws-hosted/analytics/usage-log.csv')
    expect(res.status).toBe(200)
    expect(fetchCalls).toEqual([`${CLOUD}/api/workspaces/ws-hosted/analytics/usage-log.csv`])
  })

  test('Cost Optimizer reads go upstream as well', async () => {
    const { body } = await get('/api/workspaces/ws-hosted/cost-analytics/trends')
    expect(body).toEqual({ source: 'cloud' })
    expect(fetchCalls).toEqual([`${CLOUD}/api/workspaces/ws-hosted/cost-analytics/trends`])
  })
})

describe('SHO-590 §C: everything else stays local, unchanged', () => {
  test('a workspace whose compute is the cloud\'s own keeps local rows', async () => {
    const { body } = await get('/api/workspaces/ws-cloud-compute/analytics/dashboard')
    expect(body).toEqual({ source: 'local' })
    expect(fetchCalls).toEqual([])
  })

  test('a workspace this desktop does not have keeps local rows', async () => {
    const { body } = await get('/api/workspaces/ws-unknown/analytics/dashboard')
    expect(body).toEqual({ source: 'local' })
    expect(fetchCalls).toEqual([])
  })

  test('an unpaired desktop never forwards', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const { body } = await get('/api/workspaces/ws-hosted/analytics/dashboard')
    expect(body).toEqual({ source: 'local' })
    expect(fetchCalls).toEqual([])
  })

  test('a BYOK / local-LLM desktop never forwards — the spend never reaches the cloud', async () => {
    process.env.AI_MODE = 'api-keys'
    const { body } = await get('/api/workspaces/ws-hosted/analytics/dashboard')
    expect(body).toEqual({ source: 'local' })
    expect(fetchCalls).toEqual([])
  })
})
