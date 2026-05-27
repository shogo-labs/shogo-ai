// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Closeout coverage for external-preview.ts — exercises every branch the
 * existing external-preview.test.ts doesn't: validateUrl rejects,
 * isLocalHost variants, PUT happy + reject paths, DELETE happy path,
 * 401/404, prisma settings shapes (null / partial / fully-populated),
 * runtime status branches (no runtime, runtime not running, no agentPort,
 * fetch non-ok, fetch throws), LocalPortObserver throws (debug-log path).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// State containers reset per test
let projectStore: Map<string, any>
let projectUpdates: any[] = []

// ─── auth middleware: opt-in via x-test-user-id ───
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

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: any) => projectStore.get(where.id) ?? null,
      update: async (args: any) => {
        projectUpdates.push(args)
        const cur = projectStore.get(args.where.id)
        if (cur) projectStore.set(args.where.id, { ...cur, ...args.data })
        return projectStore.get(args.where.id)
      },
    },
    projectFolder: { findMany: async () => [] },
  },
}))

// ─── runtime manager stub — toggled per test ───
let runtimeStatus: any = null
let runtimeUrl = 'http://localhost:3001'
let runtimeAgentPort: number | null = 47100
mock.module('../../lib/runtime/index', () => ({
  getRuntimeManager: () => ({
    status: () => runtimeStatus
      ? { status: runtimeStatus, url: runtimeUrl, agentPort: runtimeAgentPort }
      : null,
  }),
}))

// ─── local port observer stub — toggle attribution + throw ───
let observerAttributed: any[] = []
let observerThrows = false
mock.module('../../lib/port-observer/local-port-observer', () => ({
  getLocalPortObserver: () => ({
    attributedPorts: async () => {
      if (observerThrows) throw new Error('observer down')
      return observerAttributed
    },
  }),
}))

// ─── global.fetch stub for the detected-urls call ───
const origFetch = (globalThis as any).fetch
let fetchImpl: typeof fetch | undefined
beforeEach(() => {
  projectStore = new Map()
  projectStore.set('proj_1', { id: 'proj_1', workingMode: 'managed', settings: null, trustLevel: 'trusted' })
  projectUpdates = []
  runtimeStatus = null
  runtimeAgentPort = 47100
  observerAttributed = []
  observerThrows = false
  fetchImpl = undefined
  ;(globalThis as any).fetch = (...args: any[]) => (fetchImpl ?? origFetch)(...(args as [any]))
})

import { externalPreviewRoutes } from '../external-preview'

function app() {
  const { Hono } = require('hono')
  const a = new Hono()
  a.use('*', async (c: any, next: any) => {
    const userId = c.req.header('x-test-user-id')
    if (userId) c.set('auth', { userId, isAuthenticated: true })
    await next()
  })
  a.route('/api/projects', externalPreviewRoutes())
  return a
}

async function req(path: string, init: RequestInit = {}) {
  const a = app()
  return a.request(`/api/projects${path}`, init)
}

describe('GET /:id/external-preview', () => {
  test('401 unauthenticated', async () => {
    const r = await req('/proj_1/external-preview')
    expect(r.status).toBe(401)
  })
  test('404 project not found', async () => {
    const r = await req('/missing/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(404)
  })

  test('returns savedUrl + null detectedUrl when no runtime + no observer ports', async () => {
    projectStore.get('proj_1').settings = { externalPreview: { savedUrl: 'http://localhost:5173' } }
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    const j = await r.json() as any
    expect(j.savedUrl).toBe('http://localhost:5173')
    expect(j.detectedUrl).toBeNull()
    expect(j.attributedPorts).toEqual([])
  })

  test('observer wins over PTY detected when both present', async () => {
    runtimeStatus = 'running'
    fetchImpl = (async () => new Response(JSON.stringify({
      detections: [{ url: 'http://localhost:5174', sessionId: 's1', detectedAt: 123 }],
      mostRecent: { url: 'http://localhost:5174', sessionId: 's1', detectedAt: 123 },
    }), { status: 200 })) as any
    observerAttributed = [{ url: 'http://localhost:5173', pid: 1234 }]
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBe('http://localhost:5173')
  })

  test('PTY URL is used when observer is empty', async () => {
    runtimeStatus = 'running'
    fetchImpl = (async () => new Response(JSON.stringify({
      detections: [{ url: 'http://localhost:5174', sessionId: 's1', detectedAt: 123 }],
      mostRecent: { url: 'http://localhost:5174', sessionId: 's1', detectedAt: 123 },
    }), { status: 200 })) as any
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBe('http://localhost:5174')
  })

  test('fetchDetected returns null when runtime status !== running', async () => {
    runtimeStatus = 'starting'
    fetchImpl = (async () => { throw new Error('should not be called') }) as any
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBeNull()
  })

  test('fetchDetected returns null when no agentPort', async () => {
    runtimeStatus = 'running'
    runtimeAgentPort = null
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBeNull()
  })

  test('fetchDetected returns null when detected-urls fetch fails (non-ok)', async () => {
    runtimeStatus = 'running'
    fetchImpl = (async () => new Response('', { status: 500 })) as any
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBeNull()
  })

  test('fetchDetected returns null when detected-urls body is malformed', async () => {
    runtimeStatus = 'running'
    fetchImpl = (async () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 })) as any
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).detectedUrl).toBeNull()
  })

  test('fetchDetected swallows fetch errors (ECONNREFUSED)', async () => {
    runtimeStatus = 'running'
    fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as any
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(200)
    expect((await r.json() as any).detectedUrl).toBeNull()
  })

  test('LocalPortObserver throws → returns empty attributedPorts but request succeeds', async () => {
    observerThrows = true
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(200)
    expect((await r.json() as any).attributedPorts).toEqual([])
  })

  test('defaults workingMode to "managed" when project.workingMode is null', async () => {
    projectStore.get('proj_1').workingMode = null
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).workingMode).toBe('managed')
  })

  test('readSavedUrl returns null for non-string savedUrl in settings', async () => {
    projectStore.get('proj_1').settings = { externalPreview: { savedUrl: 42 } }
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).savedUrl).toBeNull()
  })

  test('readSavedUrl returns null when settings is non-object', async () => {
    projectStore.get('proj_1').settings = 'not an object'
    const r = await req('/proj_1/external-preview', { headers: { 'x-test-user-id': 'u1' } })
    expect((await r.json() as any).savedUrl).toBeNull()
  })
})

describe('PUT /:id/external-preview', () => {
  test('401 unauthenticated', async () => {
    const r = await req('/proj_1/external-preview', { method: 'PUT', body: JSON.stringify({}) })
    expect(r.status).toBe(401)
  })

  test('400 on invalid JSON body', async () => {
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1', 'content-type': 'application/json' },
      body: 'broken-json{',
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('invalid_json')
  })

  test('404 when project missing', async () => {
    const r = await req('/missing/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'http://localhost:5173' }),
    })
    expect(r.status).toBe(404)
  })

  test('400 invalid_url when savedUrl missing or empty', async () => {
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: '' }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('invalid_url')
  })

  test('400 malformed_url on un-parseable string', async () => {
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'http://[broken' }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('malformed_url')
  })

  test('400 unsupported_protocol on ftp://', async () => {
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'ftp://localhost/x' }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error).toBe('unsupported_protocol')
  })

  test('403 trust_required on non-local host when project is not trusted', async () => {
    projectStore.get('proj_1').trustLevel = 'sandbox'
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'https://example.com' }),
    })
    expect(r.status).toBe(403)
    const j = await r.json() as any
    expect(j.error).toBe('trust_required')
    expect(j.needsTrust).toBe(true)
  })

  test('accepts non-local host when project is trusted', async () => {
    projectStore.get('proj_1').trustLevel = 'trusted'
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'https://example.com/' }),
    })
    expect(r.status).toBe(200)
    expect((await r.json() as any).savedUrl).toBe('https://example.com')
  })

  test.each([
    ['localhost', 'http://localhost:5173/'],
    ['127.0.0.1', 'http://127.0.0.1:5173'],
    ['0.0.0.0',   'http://0.0.0.0:8080'],
    ['[::1]',     'http://[::1]:5173'],
    ['app.localhost', 'http://app.localhost'],
  ])('accepts local host %s', async (_label, url) => {
    projectStore.get('proj_1').trustLevel = 'sandbox'
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: url }),
    })
    expect(r.status).toBe(200)
  })

  test('persists merged settings without clobbering other settings keys', async () => {
    projectStore.get('proj_1').settings = {
      otherKey: 'preserved',
      externalPreview: { otherInner: 'kept' },
    }
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'http://localhost:5173' }),
    })
    expect(r.status).toBe(200)
    const update = projectUpdates[0]
    expect(update.data.settings.otherKey).toBe('preserved')
    expect(update.data.settings.externalPreview.otherInner).toBe('kept')
    expect(update.data.settings.externalPreview.savedUrl).toBe('http://localhost:5173')
  })

  test('handles null project.settings on persistence', async () => {
    projectStore.get('proj_1').settings = null
    const r = await req('/proj_1/external-preview', {
      method: 'PUT', headers: { 'x-test-user-id': 'u1' },
      body: JSON.stringify({ savedUrl: 'http://localhost:5173' }),
    })
    expect(r.status).toBe(200)
  })
})

describe('DELETE /:id/external-preview', () => {
  test('401 unauthenticated', async () => {
    const r = await req('/proj_1/external-preview', { method: 'DELETE' })
    expect(r.status).toBe(401)
  })
  test('404 when project missing', async () => {
    const r = await req('/missing/external-preview', { method: 'DELETE', headers: { 'x-test-user-id': 'u1' } })
    expect(r.status).toBe(404)
  })
  test('clears savedUrl, preserves other externalPreview fields', async () => {
    projectStore.get('proj_1').settings = {
      otherKey: 'k',
      externalPreview: { savedUrl: 'http://localhost:5173', otherInner: 'kept' },
    }
    const r = await req('/proj_1/external-preview', {
      method: 'DELETE', headers: { 'x-test-user-id': 'u1' },
    })
    expect(r.status).toBe(200)
    expect((await r.json() as any).savedUrl).toBeNull()
    const update = projectUpdates[0]
    expect(update.data.settings.externalPreview.savedUrl).toBeNull()
    expect(update.data.settings.externalPreview.otherInner).toBe('kept')
    expect(update.data.settings.otherKey).toBe('k')
  })
  test('handles null project.settings on delete (no externalPreview block)', async () => {
    projectStore.get('proj_1').settings = null
    const r = await req('/proj_1/external-preview', {
      method: 'DELETE', headers: { 'x-test-user-id': 'u1' },
    })
    expect(r.status).toBe(200)
  })
})
