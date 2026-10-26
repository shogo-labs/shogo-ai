// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `detectedUrl` has to be stable across a poll (SHO-200).
 *
 * The desktop Preview tab re-opens every time this value goes null → non-null,
 * so these tests pin the two things that used to make it move without anyone
 * touching code: the two sources disagreeing (PTY banner vs. OS-observed
 * listener) and the observer's ordering changing between polls.
 *
 * Run: bun test apps/api/src/routes/__tests__/external-preview-stability.test.ts
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

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
    projectFolder: { findMany: async () => [{ path: '/Users/me/app' }] },
  },
}))

let ptyMostRecent: { url: string } | null = null
mock.module('../../lib/runtime/index', () => ({
  getRuntimeManager: () => ({
    status: () => ({ status: 'running', agentPort: 4400, url: 'http://localhost:4400' }),
  }),
}))

let observerPorts: Array<{ url: string; port: number }> = []
mock.module('../../lib/port-observer/local-port-observer', () => ({
  getLocalPortObserver: () => ({
    async attributedPorts() {
      return observerPorts.map((p, i) => ({
        projectId: 'proj_1',
        port: p.port,
        pid: 100 + i,
        command: 'node',
        url: p.url,
        matchedFolder: '/Users/me/app',
        observedAt: Date.now(),
      }))
    },
  }),
}))

const originalFetch = globalThis.fetch
let fetchedUrls: string[] = []
beforeEach(() => {
  fetchedUrls = []
  globalThis.fetch = (async (input: any) => {
    fetchedUrls.push(typeof input === 'string' ? input : String(input?.url ?? input))
    return new Response(JSON.stringify({ detections: [], mostRecent: ptyMostRecent }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

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

async function readDetected(): Promise<string | null> {
  const res = await makeApp().request('/api/projects/proj_1/external-preview', {
    headers: { 'x-test-user-id': 'u1' },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { detectedUrl: string | null }
  return body.detectedUrl
}

describe('detectedUrl precedence', () => {
  beforeEach(() => {
    ptyMostRecent = null
    observerPorts = []
  })

  test('a PTY banner wins only while the observer sees a listener on that port', async () => {
    ptyMostRecent = { url: 'http://localhost:5173' }
    observerPorts = [
      { url: 'http://127.0.0.1:5173', port: 5173 },
      { url: 'http://127.0.0.1:3001', port: 3001 },
    ]
    expect(await readDetected()).toBe('http://localhost:5173')
  })

  test('a stale PTY banner never beats a live observed listener', async () => {
    // The banner's server is gone; the observer only sees the API server.
    ptyMostRecent = { url: 'http://localhost:5173' }
    observerPorts = [{ url: 'http://127.0.0.1:3001', port: 3001 }]
    expect(await readDetected()).toBe('http://127.0.0.1:3001')
  })

  test('the PTY banner is used when the observer sees nothing at all', async () => {
    ptyMostRecent = { url: 'http://localhost:5173' }
    observerPorts = []
    expect(await readDetected()).toBe('http://localhost:5173')
  })

  test('the detected-urls call is scoped to this project (S6)', async () => {
    ptyMostRecent = null
    await readDetected()
    expect(fetchedUrls).toHaveLength(1)
    expect(fetchedUrls[0]).toContain('/preview/detected-urls?project=proj_1')
  })
})

describe('detectedUrl stability', () => {
  beforeEach(() => {
    ptyMostRecent = null
    observerPorts = []
  })

  test('a second listener appearing or disappearing does not change the answer', async () => {
    observerPorts = [{ url: 'http://127.0.0.1:5173', port: 5173 }]
    expect(await readDetected()).toBe('http://127.0.0.1:5173')

    // An API server starts on the lower port; the observer's sticky order keeps
    // 5173 first, so the route's answer is unchanged.
    observerPorts = [
      { url: 'http://127.0.0.1:5173', port: 5173 },
      { url: 'http://127.0.0.1:3001', port: 3001 },
    ]
    expect(await readDetected()).toBe('http://127.0.0.1:5173')

    observerPorts = [{ url: 'http://127.0.0.1:5173', port: 5173 }]
    expect(await readDetected()).toBe('http://127.0.0.1:5173')
  })

  test('a saved URL never reports itself as a detection', async () => {
    projectRow.settings = { externalPreview: { savedUrl: 'http://localhost:9999' } }
    observerPorts = []
    ptyMostRecent = null
    expect(await readDetected()).toBeNull()
    projectRow.settings = { externalPreview: { savedUrl: null } }
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
