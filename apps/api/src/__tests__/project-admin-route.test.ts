// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/project-admin.ts` — admin endpoints for managing
 * Knative project pods.
 *
 * Covers all 6 endpoints:
 *   GET    /admin/pods
 *   GET    /admin/pods/:projectId
 *   POST   /admin/pods/:projectId/scale
 *   POST   /admin/pods/:projectId/warmup
 *   DELETE /admin/pods/:projectId
 *   GET    /admin/pod-stats
 *
 * For each: requireKubernetes guard (no KUBERNETES_SERVICE_HOST → 400),
 * happy path, and the catch branch.
 *
 * `../lib/knative-project-manager` is fully replaced with a spy bag.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Knative manager mock ─────────────────────────────────────────────

const managerSpies = {
  listProjects: mock(async (): Promise<any[]> => []),
  getStatus: mock(async (_: string): Promise<any> => ({ exists: false })),
  healthCheck: mock(async (_: string): Promise<boolean> => true),
  scaleProject: mock(async (_: string, __: number): Promise<void> => {}),
  createProject: mock(async (_: string): Promise<void> => {}),
  waitForReady: mock(async (_: string, __: number): Promise<void> => {}),
  deleteProject: mock(async (_: string): Promise<void> => {}),
}

mock.module('../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => managerSpies,
}))

const { projectAdminRoutes } = await import('../routes/project-admin')

// ─── helpers ──────────────────────────────────────────────────────────

function makeApp() {
  return projectAdminRoutes()
}

async function call(
  app: ReturnType<typeof projectAdminRoutes>,
  method: string,
  path: string,
  body?: any,
) {
  const init: any = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await app.fetch(new Request(`http://test${path}`, init))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

beforeEach(() => {
  // Always start tests in "in-Kubernetes" mode; flip per-test if needed
  process.env.KUBERNETES_SERVICE_HOST = 'k8s.local'
  for (const k of Object.keys(managerSpies)) {
    ;(managerSpies as any)[k].mockClear()
  }
  managerSpies.listProjects.mockImplementation(async () => [])
  managerSpies.getStatus.mockImplementation(async () => ({ exists: false }))
  managerSpies.healthCheck.mockImplementation(async () => true)
  managerSpies.scaleProject.mockImplementation(async () => {})
  managerSpies.createProject.mockImplementation(async () => {})
  managerSpies.waitForReady.mockImplementation(async () => {})
  managerSpies.deleteProject.mockImplementation(async () => {})
})

afterEach(() => {
  delete process.env.KUBERNETES_SERVICE_HOST
})

// ──────────────────────────────────────────────────────────────────────
// requireKubernetes guard
// ──────────────────────────────────────────────────────────────────────

describe('requireKubernetes guard', () => {
  test.each([
    ['GET', '/admin/pods'],
    ['GET', '/admin/pods/p1'],
    ['POST', '/admin/pods/p1/scale'],
    ['POST', '/admin/pods/p1/warmup'],
    ['DELETE', '/admin/pods/p1'],
    ['GET', '/admin/pod-stats'],
  ])('%s %s returns 400 not_kubernetes outside K8s', async (method, path) => {
    delete process.env.KUBERNETES_SERVICE_HOST
    const res = await call(makeApp(), method, path, method === 'POST' ? { replicas: 1 } : undefined)
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.error.code).toBe('not_kubernetes')
    expect(managerSpies.listProjects).not.toHaveBeenCalled()
    expect(managerSpies.getStatus).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /admin/pods
// ──────────────────────────────────────────────────────────────────────

describe('GET /admin/pods', () => {
  test('happy path: returns projects + count', async () => {
    managerSpies.listProjects.mockImplementation(async () => [
      { projectId: 'p1', status: {} },
      { projectId: 'p2', status: {} },
    ])
    const res = await call(makeApp(), 'GET', '/admin/pods')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.count).toBe(2)
    expect(res.body.data.projects).toHaveLength(2)
  })

  test('list_failed when manager throws', async () => {
    managerSpies.listProjects.mockImplementation(async () => {
      throw new Error('boom')
    })
    const res = await call(makeApp(), 'GET', '/admin/pods')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('list_failed')
    expect(res.body.error.message).toBe('boom')
  })

  test('list_failed includes default message when error has no .message', async () => {
    managerSpies.listProjects.mockImplementation(async () => {
      throw {}
    })
    const res = await call(makeApp(), 'GET', '/admin/pods')
    expect(res.status).toBe(500)
    expect(res.body.error.message).toBe('Failed to list projects')
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /admin/pods/:projectId
// ──────────────────────────────────────────────────────────────────────

describe('GET /admin/pods/:projectId', () => {
  test('not_found when status.exists=false', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: false }))
    const res = await call(makeApp(), 'GET', '/admin/pods/p1')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(managerSpies.healthCheck).not.toHaveBeenCalled()
  })

  test('happy path returns status + healthy', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true, replicas: 1 }))
    managerSpies.healthCheck.mockImplementation(async () => true)
    const res = await call(makeApp(), 'GET', '/admin/pods/p1')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      projectId: 'p1',
      status: { exists: true, replicas: 1 },
      healthy: true,
    })
  })

  test('status_failed when getStatus throws', async () => {
    managerSpies.getStatus.mockImplementation(async () => {
      throw new Error('k8s api down')
    })
    const res = await call(makeApp(), 'GET', '/admin/pods/p1')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('status_failed')
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /admin/pods/:projectId/scale
// ──────────────────────────────────────────────────────────────────────

describe('POST /admin/pods/:projectId/scale', () => {
  test('invalid_replicas: < 0 → 400', async () => {
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: -1 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_replicas')
  })

  test('invalid_replicas: > 1 → 400', async () => {
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: 2 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_replicas')
  })

  test('defaults replicas to 1 when body field is missing/non-number', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true }))
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: 'foo' })
    expect(res.status).toBe(200)
    expect(managerSpies.scaleProject).toHaveBeenCalledWith('p1', 1)
    expect(res.body.data.message).toBe('Project warmed up')
  })

  test('not_found when pod does not exist', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: false }))
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: 0 })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(managerSpies.scaleProject).not.toHaveBeenCalled()
  })

  test('replicas=0 returns "scaled to zero" message', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true }))
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toBe('Project scaled to zero')
    expect(managerSpies.scaleProject).toHaveBeenCalledWith('p1', 0)
  })

  test('scale_failed when scaleProject throws', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true }))
    managerSpies.scaleProject.mockImplementation(async () => {
      throw new Error('quota exceeded')
    })
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/scale', { replicas: 1 })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('scale_failed')
    expect(res.body.error.message).toBe('quota exceeded')
  })

  test('malformed JSON body → caught as scale_failed', async () => {
    // Bypass the normal call() helper to send invalid JSON
    const res = await makeApp().fetch(
      new Request('http://test/admin/pods/p1/scale', {
        method: 'POST',
        body: '{not-json',
        headers: { 'content-type': 'application/json' },
      }),
    )
    const body = await res.json().catch(() => ({}))
    expect(res.status).toBe(500)
    expect(body.error.code).toBe('scale_failed')
  })
})

// ──────────────────────────────────────────────────────────────────────
// POST /admin/pods/:projectId/warmup
// ──────────────────────────────────────────────────────────────────────

describe('POST /admin/pods/:projectId/warmup', () => {
  test('creates project when it does not exist, then warms it up', async () => {
    let getStatusCalls = 0
    managerSpies.getStatus.mockImplementation(async () => {
      getStatusCalls += 1
      return getStatusCalls === 1
        ? { exists: false }
        : { exists: true, ready: true }
    })
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/warmup')
    expect(res.status).toBe(200)
    expect(managerSpies.createProject).toHaveBeenCalledWith('p1')
    expect(managerSpies.scaleProject).toHaveBeenCalledWith('p1', 1)
    expect(managerSpies.waitForReady).toHaveBeenCalledWith('p1', 120000)
    expect(res.body.data.message).toBe('Project warmed up and ready')
  })

  test('skips createProject when pod already exists', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true, ready: false }))
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/warmup')
    expect(res.status).toBe(200)
    expect(managerSpies.createProject).not.toHaveBeenCalled()
    expect(managerSpies.scaleProject).toHaveBeenCalled()
  })

  test('warmup_failed when waitForReady throws', async () => {
    managerSpies.getStatus.mockImplementation(async () => ({ exists: true }))
    managerSpies.waitForReady.mockImplementation(async () => {
      throw new Error('timeout')
    })
    const res = await call(makeApp(), 'POST', '/admin/pods/p1/warmup')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('warmup_failed')
    expect(res.body.error.message).toBe('timeout')
  })
})

// ──────────────────────────────────────────────────────────────────────
// DELETE /admin/pods/:projectId
// ──────────────────────────────────────────────────────────────────────

describe('DELETE /admin/pods/:projectId', () => {
  test('happy path returns success with projectId', async () => {
    const res = await call(makeApp(), 'DELETE', '/admin/pods/p99')
    expect(res.status).toBe(200)
    expect(res.body.data.projectId).toBe('p99')
    expect(res.body.data.message).toBe('Project pod and storage deleted')
    expect(managerSpies.deleteProject).toHaveBeenCalledWith('p99')
  })

  test('delete_failed when deleteProject throws', async () => {
    managerSpies.deleteProject.mockImplementation(async () => {
      throw new Error('pvc in use')
    })
    const res = await call(makeApp(), 'DELETE', '/admin/pods/p99')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('delete_failed')
    expect(res.body.error.message).toBe('pvc in use')
  })
})

// ──────────────────────────────────────────────────────────────────────
// GET /admin/pod-stats
// ──────────────────────────────────────────────────────────────────────

describe('GET /admin/pod-stats', () => {
  test('aggregates total / ready / running / scaled_to_zero', async () => {
    managerSpies.listProjects.mockImplementation(async () => [
      { projectId: 'a', status: { ready: true,  replicas: 1 } },
      { projectId: 'b', status: { ready: false, replicas: 1 } },
      { projectId: 'c', status: { ready: false, replicas: 0 } },
      { projectId: 'd', status: { ready: true,  replicas: 2 } },
    ])
    const res = await call(makeApp(), 'GET', '/admin/pod-stats')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      total: 4,
      ready: 2,
      running: 3,
      scaled_to_zero: 1,
    })
  })

  test('empty list → all zeros', async () => {
    managerSpies.listProjects.mockImplementation(async () => [])
    const res = await call(makeApp(), 'GET', '/admin/pod-stats')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ total: 0, ready: 0, running: 0, scaled_to_zero: 0 })
  })

  test('stats_failed when listProjects throws', async () => {
    managerSpies.listProjects.mockImplementation(async () => {
      throw new Error('k8s outage')
    })
    const res = await call(makeApp(), 'GET', '/admin/pod-stats')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('stats_failed')
  })
})
