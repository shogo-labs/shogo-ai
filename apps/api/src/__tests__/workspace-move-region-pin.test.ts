// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A move has to be answered in the workspace's home region.
 *
 * A move reads a project's files from the runtime pod that holds them and hands
 * them to the store that pod reads (S3), so a request answered in a peer region
 * resolves — and boots — a runtime somewhere the workspace does not live. Same
 * class as export (#1232/#1233), so the move router carries the same pin.
 *
 * The interesting half is the body: these routes take `workspaceId` from their
 * JSON, so the pin has to run *after* the body is parsed, and a consumed
 * request stream cannot be re-sent. If the pin forwarded an empty body the
 * desktop would get a 400 from the peer and a move would fail with no clue why,
 * which is what the first test below pins down.
 *
 *   bun test apps/api/src/__tests__/workspace-move-region-pin.test.ts
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const HOME_REGION = 'home-1'
const EDGE_REGION = 'edge-1'

const homeSeen: string[] = []
const homeBodies: string[] = []
const homeApp = new Hono()
homeApp.all('/api/*', async (c) => {
  homeSeen.push(`${c.req.method} ${new URL(c.req.url).pathname}${new URL(c.req.url).search}`)
  homeBodies.push(await c.req.text())
  return c.text('SERVED_BY_HOME')
})
const homeServer = Bun.serve({ port: 0, fetch: homeApp.fetch })

process.env.REGION_ID = EDGE_REGION
process.env.REGION_PEERS = JSON.stringify([
  { id: HOME_REGION, label: 'Home', url: `http://127.0.0.1:${homeServer.port}` },
])
process.env.HOST_HEADER_FOR_PEERS = 'studio.shogo.ai'
delete process.env.CHAT_REGION_PIN

// Every workspace in this test lives in the home region. Only the rows the
// handlers reach are mocked, because a pinned request must never reach one.
mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => ({ homeRegion: HOME_REGION }) },
    project: { findMany: async () => [], findUnique: async () => null },
    conversation: { findMany: async () => [] },
    instance: { findMany: async () => [] },
    workspaceMove: { findUnique: async () => null, findMany: async () => [] },
  },
  InstanceKind: { desktop: 'desktop' },
}))

const { workspaceMoveRoutes } = await import('../routes/workspace-moves')

const edgeReached: string[] = []
const edgeApp = new Hono()
edgeApp.route('/api/workspace-moves', workspaceMoveRoutes())
// Stand-in for a handler: reaching it means the request was NOT pinned.
edgeApp.all('/api/*', (c) => {
  edgeReached.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
  return c.text('SERVED_BY_EDGE')
})
const edgeServer = Bun.serve({ port: 0, fetch: edgeApp.fetch })

afterAll(() => {
  homeServer.stop(true)
  edgeServer.stop(true)
})

async function call(path: string, init: RequestInit = {}) {
  homeSeen.length = 0
  homeBodies.length = 0
  edgeReached.length = 0
  const res = await fetch(`http://127.0.0.1:${edgeServer.port}${path}`, init)
  return { body: await res.text(), status: res.status }
}

const jsonHeaders = { 'content-type': 'application/json' }

describe('the move routes that carry files are served by the home region', () => {
  test('a JSON body reaches the peer intact', async () => {
    const payload = { workspaceId: 'ws_home', projectId: 'p_1' }
    const res = await call('/api/workspace-moves/serve/files/manifest', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    })
    expect(res.body).toBe('SERVED_BY_HOME')
    expect(edgeReached).toEqual([])
    expect(homeBodies).toEqual([JSON.stringify(payload)])
  })

  test('a query-string workspace id is pinned before anything is read', async () => {
    const res = await call('/api/workspace-moves/serve/files/raw?workspaceId=ws_home&projectId=p_1&path=a.txt')
    expect(res.body).toBe('SERVED_BY_HOME')
    expect(edgeReached).toEqual([])
    expect(homeSeen).toEqual([
      'GET /api/workspace-moves/serve/files/raw?workspaceId=ws_home&projectId=p_1&path=a.txt',
    ])
  })

  test('a PUT file stream reaches the peer byte for byte', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const res = await call('/api/workspace-moves/receive/files/raw?workspaceId=ws_home&projectId=p_1&path=b.bin', {
      method: 'PUT',
      body: bytes,
    })
    expect(res.body).toBe('SERVED_BY_HOME')
    expect(edgeReached).toEqual([])
    expect(homeBodies).toEqual([new TextDecoder().decode(bytes)])
  })

  test('the flush, receive manifest and driver routes are pinned too', async () => {
    for (const [method, path, payload] of [
      ['POST', '/api/workspace-moves/receive/files/flush', { workspaceId: 'ws_home', projectId: 'p_1' }],
      ['POST', '/api/workspace-moves/receive/files/manifest', { workspaceId: 'ws_home', projectId: 'p_1' }],
      ['POST', '/api/workspace-moves/plan', { workspaceId: 'ws_home', direction: 'cloud_to_desktop' }],
      ['POST', '/api/workspace-moves', { workspaceId: 'ws_home', direction: 'desktop_to_cloud' }],
    ] as const) {
      const res = await call(path, { method, headers: jsonHeaders, body: JSON.stringify(payload) })
      expect(res.body).toBe('SERVED_BY_HOME')
      expect(edgeReached).toEqual([])
      expect(homeBodies).toEqual([JSON.stringify(payload)])
    }
  })
})

describe('the routes that must stay local are not pinned', () => {
  // `/receive/init` creates the target workspace on THIS instance: proxying it
  // would hand the new workspace to a peer region the mover never asked for.
  test('receive/init is handled where it lands', async () => {
    const res = await call('/api/workspace-moves/receive/init', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Moved', sourceWorkspaceId: 'ws_src' }),
    })
    expect(homeSeen).toEqual([])
    expect(res.body).not.toBe('SERVED_BY_HOME')
  })
})
