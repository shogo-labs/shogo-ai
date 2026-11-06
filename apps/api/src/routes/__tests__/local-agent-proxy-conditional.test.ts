// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The local (desktop) agent proxy must not break conditional file reads.
 *
 * The IDE asks the runtime "is this file still the version I have?" with
 * `If-None-Match` and expects a bodiless `304` back when it is unchanged
 * (PERF-10). A proxy that drops the request header, or turns a 304 into a 200
 * with a body, silently undoes that and puts the IDE back on full reads — so
 * the pass-through is pinned here, next to the desktop route that does it.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

const store = {
  upstreamCalls: [] as Array<{ url: string; headers: Headers }>,
  upstream: null as null | (() => Response),
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === 'p1' ? { id: 'p1', workspaceId: 'w1' } : null,
    },
  },
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://pod.test' }),
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'runtime-token',
}))

const realFetch = globalThis.fetch

beforeEach(() => {
  store.upstreamCalls = []
  store.upstream = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    store.upstreamCalls.push({ url, headers: new Headers(init?.headers) })
    if (!store.upstream) throw new Error('no upstream stub')
    return store.upstream()
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function buildApp() {
  const { Hono } = await import('hono')
  const { localAgentProxyRoutes } = await import('../local-agent-proxy')
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { isAuthenticated: true, userId: 'u1' })
    await next()
  })
  // Mounted where the real API mounts it: the handler strips the
  // `/api/projects/:projectId/agent-proxy` prefix off `c.req.path`.
  app.route('/api', localAgentProxyRoutes({ runtimeManager: {} as any }))
  return app
}

const PATH = '/api/projects/p1/agent-proxy/agent/workspace/files/src/a.ts'

describe('local agent proxy — conditional reads', () => {
  test('forwards If-None-Match upstream', async () => {
    store.upstream = () =>
      new Response(null, { status: 304, headers: { ETag: 'W/"12-3"' } })
    const app = await buildApp()

    const res = await app.fetch(
      new Request(`http://api.test${PATH}`, {
        headers: { 'if-none-match': 'W/"12-3"' },
      }),
    )

    expect(store.upstreamCalls).toHaveLength(1)
    expect(store.upstreamCalls[0]!.headers.get('if-none-match')).toBe('W/"12-3"')
    expect(store.upstreamCalls[0]!.headers.get('x-runtime-token')).toBe('runtime-token')
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('W/"12-3"')
    expect(await res.text()).toBe('')
  })

  test('a 200 passes the ETag and the body through untouched', async () => {
    store.upstream = () =>
      new Response(JSON.stringify({ path: 'src/a.ts', content: 'x', encoding: 'utf-8', bytes: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: 'W/"13-3"' },
      })
    const app = await buildApp()

    const res = await app.fetch(
      new Request(`http://api.test${PATH}`, {
        headers: { 'if-none-match': 'W/"12-3"' },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('W/"13-3"')
    expect((await res.json()) as { content: string }).toEqual({
      path: 'src/a.ts',
      content: 'x',
      encoding: 'utf-8',
      bytes: 1,
    })
  })

  test('no If-None-Match on the request means none upstream', async () => {
    store.upstream = () => new Response(JSON.stringify({ content: 'x' }), { status: 200 })
    const app = await buildApp()

    await app.fetch(new Request(`http://api.test${PATH}`))

    expect(store.upstreamCalls[0]!.headers.get('if-none-match')).toBeNull()
  })

  test('a plain GET is not given a body it did not ask for', async () => {
    store.upstream = () => new Response('{"ok":true}', { status: 200 })
    const app = await buildApp()

    await app.fetch(new Request(`http://api.test${PATH}`))

    expect(store.upstreamCalls[0]!.url).toBe(
      'http://pod.test/agent/workspace/files/src/a.ts',
    )
  })
})
