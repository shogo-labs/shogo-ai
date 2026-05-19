// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

interface MockManager {
  listProjects: ReturnType<typeof mock>
  getStatus: ReturnType<typeof mock>
  healthCheck: ReturnType<typeof mock>
  scaleProject: ReturnType<typeof mock>
  createProject: ReturnType<typeof mock>
  waitForReady: ReturnType<typeof mock>
  deleteProject: ReturnType<typeof mock>
}

let mgr: MockManager

function freshMgr(): MockManager {
  return {
    listProjects: mock(async () => []),
    getStatus: mock(async () => ({ exists: false, ready: false, replicas: 0 })),
    healthCheck: mock(async () => true),
    scaleProject: mock(async () => undefined),
    createProject: mock(async () => undefined),
    waitForReady: mock(async () => undefined),
    deleteProject: mock(async () => undefined),
  }
}

mgr = freshMgr()

mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => mgr,
}))

const { projectAdminRoutes } = await import('../project-admin')

function makeApp() {
  // Hono import has to happen after the mock above to keep timing consistent.
  // We import lazily here so each call composes a fresh router.
  const { Hono } = require('hono')
  const app = new Hono()
  app.route('/', projectAdminRoutes())
  return app
}

const originalEnv = process.env.KUBERNETES_SERVICE_HOST
beforeEach(() => {
  mgr.listProjects = mock(async () => [])
  mgr.getStatus = mock(async () => ({ exists: false, ready: false, replicas: 0 }))
  mgr.healthCheck = mock(async () => true)
  mgr.scaleProject = mock(async () => undefined)
  mgr.createProject = mock(async () => undefined)
  mgr.waitForReady = mock(async () => undefined)
  mgr.deleteProject = mock(async () => undefined)
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = originalEnv
})

// ─── not-kubernetes guard (hits requireKubernetes branch on every route) ────

describe('requireKubernetes guard', () => {
  for (const [method, path] of [
    ['GET', '/admin/pods'],
    ['GET', '/admin/pods/p1'],
    ['POST', '/admin/pods/p1/scale'],
    ['POST', '/admin/pods/p1/warmup'],
    ['DELETE', '/admin/pods/p1'],
    ['GET', '/admin/pod-stats'],
  ] as const) {
    test(`${method} ${path} returns 400 not_kubernetes when env unset`, async () => {
      delete process.env.KUBERNETES_SERVICE_HOST
      const app = makeApp()
      const res = await app.request(path, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error.code).toBe('not_kubernetes')
    })
  }
})

// ─── GET /admin/pods ────────────────────────────────────────────────────────

describe('GET /admin/pods', () => {
  test('returns list of projects', async () => {
    mgr.listProjects = mock(async () => [
      { projectId: 'a', status: { ready: true, replicas: 1 } },
      { projectId: 'b', status: { ready: false, replicas: 0 } },
    ])
    const res = await makeApp().request('/admin/pods')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.count).toBe(2)
    expect(body.data.projects).toHaveLength(2)
  })
  test('500 when manager throws (message preserved)', async () => {
    mgr.listProjects = mock(async () => { throw new Error('k8s down') })
    const res = await makeApp().request('/admin/pods')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('list_failed')
    expect(body.error.message).toBe('k8s down')
  })
  test('500 with default message when error has no message', async () => {
    mgr.listProjects = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pods')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.message).toBe('Failed to list projects')
  })
})

// ─── GET /admin/pods/:projectId ─────────────────────────────────────────────

describe('GET /admin/pods/:projectId', () => {
  test('404 when project does not exist', async () => {
    mgr.getStatus = mock(async () => ({ exists: false }))
    const res = await makeApp().request('/admin/pods/p1')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('not_found')
  })
  test('200 + healthy', async () => {
    mgr.getStatus = mock(async () => ({ exists: true, ready: true, replicas: 1 }))
    mgr.healthCheck = mock(async () => true)
    const res = await makeApp().request('/admin/pods/p1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.projectId).toBe('p1')
    expect(body.data.healthy).toBe(true)
  })
  test('500 when getStatus throws', async () => {
    mgr.getStatus = mock(async () => { throw new Error('boom') })
    const res = await makeApp().request('/admin/pods/p1')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('status_failed')
  })
  test('500 with default message', async () => {
    mgr.getStatus = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pods/p1')
    const body = await res.json()
    expect(body.error.message).toBe('Failed to get project status')
  })
})

// ─── POST /admin/pods/:projectId/scale ──────────────────────────────────────

describe('POST /admin/pods/:projectId/scale', () => {
  test('400 when replicas out of range', async () => {
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 5 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_replicas')
  })
  test('400 when replicas negative', async () => {
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: -1 }),
    })
    expect(res.status).toBe(400)
  })
  test('404 when project does not exist', async () => {
    mgr.getStatus = mock(async () => ({ exists: false }))
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 1 }),
    })
    expect(res.status).toBe(404)
  })
  test('200 scale to 1 (warmed up)', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 1 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.message).toBe('Project warmed up')
    expect(mgr.scaleProject).toHaveBeenCalledWith('p1', 1)
  })
  test('200 scale to 0', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 0 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.message).toBe('Project scaled to zero')
  })
  test('200 with default replicas=1 when body omits the key', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(mgr.scaleProject).toHaveBeenCalledWith('p1', 1)
  })
  test('500 when scaleProject throws', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    mgr.scaleProject = mock(async () => { throw new Error('apiserver') })
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 1 }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('scale_failed')
  })
  test('500 default message when scale throws empty', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    mgr.scaleProject = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pods/p1/scale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replicas: 1 }),
    })
    expect((await res.json()).error.message).toBe('Failed to scale project')
  })
})

// ─── POST /admin/pods/:projectId/warmup ─────────────────────────────────────

describe('POST /admin/pods/:projectId/warmup', () => {
  test('creates project if missing then warms up', async () => {
    let exists = false
    mgr.getStatus = mock(async () => ({ exists, ready: exists, replicas: exists ? 1 : 0 }))
    mgr.createProject = mock(async () => { exists = true })
    const res = await makeApp().request('/admin/pods/new1/warmup', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mgr.createProject).toHaveBeenCalledWith('new1')
    expect(mgr.scaleProject).toHaveBeenCalledWith('new1', 1)
    expect(mgr.waitForReady).toHaveBeenCalledWith('new1', 120000)
  })
  test('skips createProject when project already exists', async () => {
    mgr.getStatus = mock(async () => ({ exists: true, ready: true, replicas: 1 }))
    const res = await makeApp().request('/admin/pods/p1/warmup', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mgr.createProject).not.toHaveBeenCalled()
    expect(mgr.scaleProject).toHaveBeenCalled()
  })
  test('500 when waitForReady throws', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    mgr.waitForReady = mock(async () => { throw new Error('timeout') })
    const res = await makeApp().request('/admin/pods/p1/warmup', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('warmup_failed')
  })
  test('500 default message when warmup throws empty', async () => {
    mgr.getStatus = mock(async () => ({ exists: true }))
    mgr.waitForReady = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pods/p1/warmup', { method: 'POST' })
    expect((await res.json()).error.message).toBe('Failed to warm up project')
  })
})

// ─── DELETE /admin/pods/:projectId ──────────────────────────────────────────

describe('DELETE /admin/pods/:projectId', () => {
  test('200 deletes the project', async () => {
    const res = await makeApp().request('/admin/pods/p1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mgr.deleteProject).toHaveBeenCalledWith('p1')
  })
  test('500 when delete throws', async () => {
    mgr.deleteProject = mock(async () => { throw new Error('busy') })
    const res = await makeApp().request('/admin/pods/p1', { method: 'DELETE' })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('delete_failed')
  })
  test('500 default message', async () => {
    mgr.deleteProject = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pods/p1', { method: 'DELETE' })
    expect((await res.json()).error.message).toBe('Failed to delete project')
  })
})

// ─── GET /admin/pod-stats ───────────────────────────────────────────────────

describe('GET /admin/pod-stats', () => {
  test('aggregates ready/running/scaled_to_zero counts', async () => {
    mgr.listProjects = mock(async () => [
      { projectId: 'a', status: { ready: true, replicas: 1 } },
      { projectId: 'b', status: { ready: false, replicas: 1 } },
      { projectId: 'c', status: { ready: true, replicas: 0 } },
      { projectId: 'd', status: { ready: false, replicas: 0 } },
    ])
    const res = await makeApp().request('/admin/pod-stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ total: 4, ready: 2, running: 2, scaled_to_zero: 2 })
  })
  test('500 when listProjects throws', async () => {
    mgr.listProjects = mock(async () => { throw new Error('apiserver') })
    const res = await makeApp().request('/admin/pod-stats')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('stats_failed')
  })
  test('500 default message', async () => {
    mgr.listProjects = mock(async () => { throw {} })
    const res = await makeApp().request('/admin/pod-stats')
    expect((await res.json()).error.message).toBe('Failed to get stats')
  })
})

// ─── default export is the same factory ─────────────────────────────────────

describe('module shape', () => {
  test('default export equals named export', async () => {
    const mod = await import('../project-admin')
    expect(mod.default).toBe(mod.projectAdminRoutes)
  })
})
