// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SEC-18 hotfix: the cloud composer mounts `/api/workspace-moves` only when
 * `WORKSPACE_MOVES_ENABLED=true`.
 *
 * The surface was live on the public API (v2.4.5/v2.4.6) with no scoping behind
 * it: every route authorised `workspace:move` against a `workspaceId` the caller
 * supplies — and every user owns their personal workspace — then trusted the
 * `projectId`, model name and row ids that came with it. `/serve/files/raw` read
 * any file on the pod, `/receive/records` wrote any row.
 *
 * This test builds the composer's mount the way `server.ts` does (the real app
 * cannot be booted here: it starts workers and needs Redis) and asserts the
 * route is absent by default and present when explicitly enabled.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

// Must run before anything imports lib/prisma.
const { dir: dbDir } = setupChannelsTestDb()

const { Hono } = await import('hono')
const { workspaceMoveRoutes, workspaceMovesMountable } = await import('../routes/workspace-moves')

/** The cloud composer's mount, minus the ten thousand other routes. */
function cloudApp(env: Record<string, string | undefined>): InstanceType<typeof Hono> {
  const app = new Hono()
  if (workspaceMovesMountable(env)) app.route('/api/workspace-moves', workspaceMoveRoutes())
  return app
}

describe('SEC-18 hotfix: the cloud mount is opt-in', () => {
  test('defaults to off, and only an explicit "true" turns it on', () => {
    expect(workspaceMovesMountable({})).toBe(false)
    expect(workspaceMovesMountable({ WORKSPACE_MOVES_ENABLED: '' })).toBe(false)
    expect(workspaceMovesMountable({ WORKSPACE_MOVES_ENABLED: '1' })).toBe(false)
    expect(workspaceMovesMountable({ WORKSPACE_MOVES_ENABLED: 'TRUE' })).toBe(false)
    expect(workspaceMovesMountable({ WORKSPACE_MOVES_ENABLED: 'true' })).toBe(true)
  })

  test('every route under the surface is a 404 on a cloud build without the flag', async () => {
    const app = cloudApp({})
    for (const [method, path] of [
      ['GET', '/api/workspace-moves/options'],
      ['GET', '/api/workspace-moves'],
      ['POST', '/api/workspace-moves/plan'],
      ['GET', '/api/workspace-moves/serve/files/raw'],
      ['PUT', '/api/workspace-moves/receive/files/raw'],
      ['POST', '/api/workspace-moves/receive/records'],
    ] as const) {
      const res = await app.fetch(new Request(`http://localhost${path}`, { method }))
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
    }
  })

  test('with the flag set the route is mounted and answers as the surface, not as a 404', async () => {
    const app = cloudApp({ WORKSPACE_MOVES_ENABLED: 'true' })
    const res = await app.fetch(new Request('http://localhost/api/workspace-moves/options'))
    expect(res.status).not.toBe(404)
    // No `workspaceId` in the query, so the handler's own guard answers first.
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('workspace_required')
  })
})

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true })
})
