// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/local/machine` — the desktop-side half of SHO-54.
 *
 * The snapshot is owner-only: it answers for the tunnelled cloud call (the
 * cloud has already verified the session and stamped `x-tunnel-auth-user-id`)
 * and for the desktop's own local session. Being on loopback is not enough —
 * an unauthenticated request, an API key and a project runtime token are all
 * refused, because any local process could otherwise read the machine's
 * workspace list.
 *
 *   bun test apps/api/src/__tests__/local-machine.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'

const SNAPSHOT = {
  machine: { id: 'device-1', name: 'mac', hostname: 'mac', os: 'darwin', arch: 'arm64' },
  workspaces: [
    { id: 'lw-1', name: 'Personal', kind: 'personal', projectCount: 2, lastActivityAt: null },
  ],
  activity: { runningTurns: 0, runningTasks: 0, chats: 3, lastActivityAt: null },
  generatedAt: '2026-10-19T10:00:00.000Z',
}

mock.module('../lib/machine-snapshot', () => ({
  collectMachineSnapshot: async () => SNAPSHOT,
}))

const { localMachineRoutes } = await import('../routes/local-machine')

function appWith(auth: any) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/api/local', localMachineRoutes())
  return app
}

describe('GET /api/local/machine', () => {
  test('answers a tunnelled cloud call for its owner', async () => {
    const res = await appWith({ userId: 'u-1', isAuthenticated: true, via: 'tunnel' }).request(
      '/api/local/machine',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.workspaces[0].id).toBe('lw-1')
    expect(body.machine.hostname).toBe('mac')
  })

  test('answers the desktop’s own local session', async () => {
    const res = await appWith({ userId: 'local-user', isAuthenticated: true, via: 'session' }).request(
      '/api/local/machine',
    )
    expect(res.status).toBe(200)
  })

  test('refuses an unauthenticated request on loopback', async () => {
    const res = await appWith({ isAuthenticated: false }).request('/api/local/machine')
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('forbidden')
  })

  test('refuses an API key / runtime token caller', async () => {
    for (const via of ['apiKey', 'runtimeToken']) {
      const res = await appWith({ userId: 'u-1', isAuthenticated: true, via }).request(
        '/api/local/machine',
      )
      expect(res.status).toBe(403)
    }
  })
})
