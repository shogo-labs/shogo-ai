// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-452 — a sub-router mounted at bare `/api` must not put its own auth
 * middleware on every `/api/*` route registered after it.
 *
 * Hono's `app.route('/api', subApp)` folds the sub-app's routes into the
 * parent's chain at that point, so a `subApp.use('*', requireAuth)` becomes
 * `app.use('/api/*', requireAuth)` for everything registered later. SHO-424's
 * compute-usage router did exactly that and 401'd preview render/open,
 * `/api/f/<token>` download links and published-site wake/API for
 * unauthenticated callers — staging previews were dead from the Nov 18 17:28Z
 * batch until this fix.
 *
 * This suite boots the real `server.ts` app (not a hand-built Hono) and asks
 * for those public paths with no session, no Origin and no Referer — the same
 * shape as the `curl` that reproduced the outage. Each must reach its handler
 * (404 for a bogus id) instead of being rejected by auth (401).
 *
 * Run: bun test apps/api/src/__tests__/public-routes-not-poisoned-by-subrouter-auth.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir
process.env.WORKSPACES_DIR = `${dir}/workspaces`

const server = (await import('../server')).default as any

/** An unauthenticated request with no Origin/Referer, as `curl` sends it. */
function get(path: string): Promise<Response> {
  return server.fetch(new Request(`http://127.0.0.1:3999${path}`), {})
}

afterAll(async () => {
  const { prisma } = await import('../lib/prisma')
  await prisma.$disconnect().catch(() => {})
})

describe('public /api routes stay reachable without a session', () => {
  test('/api/f/<token> reaches the file handler (404 invalid_link, not 401)', async () => {
    const res = await get('/api/f/doesnotexist')
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(404)
  })

  test('/api/preview/<id>/render reaches the preview handler (not 401)', async () => {
    const res = await get('/api/preview/00000000-0000-4000-8000-000000000000/render')
    expect(res.status).not.toBe(401)
  })

  test('/api/published/<subdomain>/wake reaches the published-site handler (not 401)', async () => {
    const res = await get('/api/published/nosuchsite/wake')
    expect(res.status).not.toBe(401)
  })
})

describe('the routers that were mounted at bare /api still require auth', () => {
  test('/api/workspaces/<id>/compute-usage is 401 without a session', async () => {
    const res = await get('/api/workspaces/00000000-0000-4000-8000-000000000000/compute-usage')
    expect(res.status).toBe(401)
  })

  test('/api/workspaces/<id>/analytics/overview is 401 without a session', async () => {
    const res = await get('/api/workspaces/00000000-0000-4000-8000-000000000000/analytics/overview')
    expect(res.status).toBe(401)
  })

  test('/api/workspaces/<id>/cost-analytics/agent-breakdown is 401 without a session', async () => {
    const res = await get('/api/workspaces/00000000-0000-4000-8000-000000000000/cost-analytics/agent-breakdown')
    expect(res.status).toBe(401)
  })
})
