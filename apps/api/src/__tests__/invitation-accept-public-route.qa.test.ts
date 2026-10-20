// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance spec for SHO-83 — the public `GET /api/invitations/:id/info`
 * the emailed accept page fetches *before* the invitee has a session.
 *
 * The dev's own spec drives the route handler and the `isPublicPath` predicate
 * separately. This one puts them together the way production does:
 *
 *   - the real `requireAuth` middleware in front of the real router (an
 *     anonymous request has to come back 200 with context, not 401), with a
 *     positive control proving the sibling CRUD paths still 401;
 *   - the *global* gate predicate (`isGatePublicPath`, api-auth-gate), which is
 *     the middleware that actually runs first on `/api/*` in server.ts — the
 *     dev's spec only covered `isPublicPath`;
 *   - mount order in server.ts: the info route has to be registered before the
 *     generated routers, or `/:id/info` is swallowed by generated `GET /:id`.
 *
 * Run: bun test ./apps/api/src/__tests__/invitation-accept-public-route.qa.test.ts
 */

import { describe, expect, test, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

mock.module('../lib/prisma', () => withPrismaExports({ prisma: {} }))

process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-invitation-public'

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

const invitations: Record<string, any> = {
  'inv-open': {
    id: 'inv-open',
    email: 'invitee@example.com',
    role: 'admin',
    status: 'pending',
    expiresAt: future,
    workspaceId: 'ws-1',
    projectId: null,
    workspace: { name: 'Acme' },
  },
}

const db = {
  invitation: {
    findUnique: mock(async ({ where }: any) => invitations[where.id] ?? null),
  },
  project: { findUnique: mock(async () => null) },
}

const { invitationInfoRoutes } = await import('../routes/invitation-info')
const { requireAuth } = await import('../middleware/auth')
const { isGatePublicPath } = await import('../middleware/api-auth-gate')

/** The production shape: gate/auth in front of the router, no session. */
function createGatedApp() {
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    c.set('auth', { isAuthenticated: false, userId: null })
    await next()
  })
  app.use('/api/*', requireAuth)
  app.route('/api/invitations', invitationInfoRoutes({ prisma: db }))
  return app
}

describe('SHO-83 — the accept page can read its invitation without a session', () => {
  test('anonymous GET /api/invitations/:id/info is 200 with the context the page renders', async () => {
    const res = await createGatedApp().request('/api/invitations/inv-open/info')

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toMatchObject({
      role: 'admin',
      status: 'pending',
      expired: false,
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
    })
  })

  test('positive control: the sibling generated paths still require a session', async () => {
    const app = createGatedApp()

    expect((await app.request('/api/invitations/inv-open')).status).toBe(401)
    expect((await app.request('/api/invitations')).status).toBe(401)
    expect((await app.request('/api/invitations/inv-open/accept')).status).toBe(401)
  })

  test('the global gate (api-auth-gate) lets exactly the info subpath through', () => {
    expect(isGatePublicPath('/api/invitations/inv-open/info')).toBe(true)
    expect(isGatePublicPath('/api/invitations/inv-open')).toBe(false)
    expect(isGatePublicPath('/api/invitations')).toBe(false)
    expect(isGatePublicPath('/api/invitations/inv-open/info/extra')).toBe(false)
  })

  test('the info route is mounted before the generated routers, so /:id/info cannot be swallowed', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    const infoMount = server.indexOf("app.route('/api/invitations', invitationInfoRoutes())")
    const generatedMount = server.indexOf("app.route('/api', generatedRoutes)")

    expect(infoMount).toBeGreaterThan(-1)
    expect(generatedMount).toBeGreaterThan(-1)
    expect(infoMount).toBeLessThan(generatedMount)
  })
})
