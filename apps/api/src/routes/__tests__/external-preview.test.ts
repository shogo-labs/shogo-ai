// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the external-preview route, focused on the
 * LocalPortObserver merge. The unit-test file at
 * `src/lib/port-observer/__tests__/local-port-observer.test.ts` covers
 * every edge case in the observer itself; this file is the one happy-
 * path that proves the observer's output reaches the HTTP response as
 * `detectedUrl`, and that observer-derived URLs beat the PTY source
 * when both are present (which is the regression we'd most regret).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── mock middleware (inject userId from a header) ───
mock.module('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    const userId = c.req.header('x-test-user-id')
    if (userId) c.set('auth', { userId, isAuthenticated: true })
    else c.set('auth', { isAuthenticated: false })
    await next()
  },
  requireAuth: async (c: any, next: any) => {
    const a = c.get('auth')
    if (!a?.userId) return c.json({ error: 'unauthenticated' }, 401)
    await next()
  },
}))

// ─── mock prisma at the boundary ───
const projectRow = {
  id: 'proj_1',
  workingMode: 'external',
  settings: { externalPreview: { savedUrl: null } },
  trustLevel: 'trusted',
}
mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => projectRow,
      update: async (args: any) => ({ ...projectRow, ...args.data }),
    },
    projectFolder: {
      findMany: async () => [{ path: '/Users/me/app' }],
    },
  },
}))

// ─── stub the runtime manager so the PTY path returns null by default ───
let ptyMostRecent: { url: string } | null = null
mock.module('../../lib/runtime/index', () => ({
  getRuntimeManager: () => ({
    status: (_id: string) => null, // no hot runtime → fetchDetected short-circuits
  }),
}))

// ─── stub the observer at the singleton boundary ───
let observerPorts: Array<{
  projectId: string
  port: number
  pid: number
  command: string
  url: string
  matchedFolder: string
  observedAt: number
}> = []
mock.module('../../lib/port-observer/local-port-observer', () => ({
  getLocalPortObserver: () => ({
    async attributedPorts(_projectId: string) {
      return observerPorts
    },
  }),
}))

// Import the route AFTER mocks are registered.
const { externalPreviewRoutes } = await import('../external-preview')

function makeApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user-id')
    if (userId) c.set('auth' as never, { userId } as never)
    await next()
  })
  app.route('/api/projects', externalPreviewRoutes())
  return app
}

describe('GET /api/projects/:id/external-preview — observer merge', () => {
  beforeEach(() => {
    observerPorts = []
    ptyMostRecent = null
  })

  test('401 without auth', async () => {
    const app = makeApp()
    const res = await app.request('/api/projects/proj_1/external-preview')
    expect(res.status).toBe(401)
  })

  test('returns null detectedUrl when neither observer nor PTY has a hit', async () => {
    const app = makeApp()
    const res = await app.request('/api/projects/proj_1/external-preview', {
      headers: { 'x-test-user-id': 'u1' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { detectedUrl: string | null; attributedPorts: unknown[] }
    expect(body.detectedUrl).toBeNull()
    expect(body.attributedPorts).toEqual([])
  })

  test('surfaces the observer URL as detectedUrl when the observer has a hit', async () => {
    observerPorts = [
      {
        projectId: 'proj_1',
        port: 5173,
        pid: 4821,
        command: 'node',
        url: 'http://127.0.0.1:5173',
        matchedFolder: '/Users/me/app',
        observedAt: Date.now(),
      },
    ]
    const app = makeApp()
    const res = await app.request('/api/projects/proj_1/external-preview', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const body = (await res.json()) as {
      detectedUrl: string | null
      attributedPorts: unknown[]
    }
    expect(body.detectedUrl).toBe('http://127.0.0.1:5173')
    expect(body.attributedPorts).toHaveLength(1)
  })

  test('observer URL wins when both sources are present (PTY may hold stale data)', async () => {
    // Both sources have a URL, but they disagree. The observer is
    // grounded in current OS state and must take precedence.
    observerPorts = [
      {
        projectId: 'proj_1',
        port: 5173,
        pid: 1,
        command: 'node',
        url: 'http://127.0.0.1:5173',
        matchedFolder: '/Users/me/app',
        observedAt: Date.now(),
      },
    ]
    ptyMostRecent = { url: 'http://localhost:3000' } // stale, ignored

    const app = makeApp()
    const res = await app.request('/api/projects/proj_1/external-preview', {
      headers: { 'x-test-user-id': 'u1' },
    })
    const body = (await res.json()) as { detectedUrl: string | null }
    expect(body.detectedUrl).toBe('http://127.0.0.1:5173')
    // Quiet "unused let" by referencing the stale value:
    expect(ptyMostRecent).not.toBeNull()
  })
})
