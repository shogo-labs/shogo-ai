// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/runtime.ts — runtime lifecycle + sandbox URL.
 *
 * Four endpoints: start, stop, status, sandbox/url, restart.
 *
 * Strategy:
 *  - Mock ../lib/prisma (project.findUnique)
 *  - Mock ../lib/resolve-pod-url (the dynamic import inside start /
 *    restart / sandbox handlers) to inject mode='host' | 'vm' | 'k8s'
 *    behaviour deterministically
 *  - Mock 'fs' (existsSync) for the filesystem-fallback validateProject
 *    branch when DB lookup throws
 *  - Pass a stub runtimeManager so we never spawn processes
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── prisma mock ──────────────────────────────────────────────────────────

const projectFindUnique = mock(async (_: any): Promise<any> => null)
mock.module('../lib/prisma', () => ({
  prisma: { project: { findUnique: projectFindUnique } },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── resolve-pod-url mock (dynamic import target) ─────────────────────────

const resolveProjectPodUrlMock = mock(async (_: string, _opts: any) => ({
  mode: 'host' as const,
  runtime: {
    status: 'running' as const,
    url: 'http://127.0.0.1:8000',
    port: 8000,
    agentPort: 9000,
  },
}))
mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: resolveProjectPodUrlMock,
}))

// ─── fs existsSync mock (for filesystem fallback) ─────────────────────────

const existsSyncMock = mock((_: string) => false)
mock.module('fs', () => ({ existsSync: existsSyncMock }))

// ─── runtimeManager stub ──────────────────────────────────────────────────

const rmStatusMock = mock((_: string) => null as any)
const rmStartMock = mock(async (_: string) => ({}))
const rmStopMock = mock(async (_: string) => {})

const runtimeManager = {
  status: rmStatusMock,
  start: rmStartMock,
  stop: rmStopMock,
} as any

// ─── env scaffolding ──────────────────────────────────────────────────────
// ─── load route under test (AFTER mocks) ──────────────────────────────────

const { runtimeRoutes } = await import('../routes/runtime')


const SAVED_ENV = {
  SHOGO_VM_ISOLATION: process.env.SHOGO_VM_ISOLATION,
  KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
  API_PORT: process.env.API_PORT,
  PORT: process.env.PORT,
}

function makeApp(opts: { workspacesDir?: string } = {}) {
  const app = new Hono()
  app.route('/api', runtimeRoutes({ runtimeManager, ...opts }))
  return app
}

beforeEach(() => {
  projectFindUnique.mockReset()
  projectFindUnique.mockImplementation(async () => ({
    id: 'proj-1',
    name: 'Hello',
    workspaceId: 'ws-1',
  }))
  resolveProjectPodUrlMock.mockReset()
  resolveProjectPodUrlMock.mockImplementation(async () => ({
    mode: 'host' as const,
    runtime: {
      status: 'running' as const,
      url: 'http://127.0.0.1:8000',
      port: 8000,
      agentPort: 9000,
    },
  }))
  existsSyncMock.mockReset()
  existsSyncMock.mockImplementation(() => false)
  rmStatusMock.mockReset()
  rmStatusMock.mockImplementation(() => null as any)
  rmStartMock.mockReset()
  rmStartMock.mockImplementation(async () => ({}))
  rmStopMock.mockReset()
  rmStopMock.mockImplementation(async () => {})

  delete process.env.SHOGO_VM_ISOLATION
  delete process.env.KUBERNETES_SERVICE_HOST
})

afterEach(() => {
  if (SAVED_ENV.SHOGO_VM_ISOLATION === undefined) delete process.env.SHOGO_VM_ISOLATION
  else process.env.SHOGO_VM_ISOLATION = SAVED_ENV.SHOGO_VM_ISOLATION
  if (SAVED_ENV.KUBERNETES_SERVICE_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = SAVED_ENV.KUBERNETES_SERVICE_HOST
})

// ─── validateProject — DB hit + FS fallback ───────────────────────────────

describe('validateProject — DB hit + FS fallback', () => {
  test('happy path uses DB row', async () => {
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(projectFindUnique).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      select: { id: true, name: true, workspaceId: true },
    })
  })

  test('404 when project is not in DB and no workspacesDir is configured', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('project_not_found')
  })

  test('404 when DB miss AND workspacesDir set but folder missing on disk', async () => {
    projectFindUnique.mockImplementation(async () => null)
    existsSyncMock.mockImplementation(() => false)
    const res = await makeApp({ workspacesDir: '/srv/ws' }).request(
      '/api/projects/p404/runtime/start',
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  test('DB throws + FS fallback succeeds: project is accepted', async () => {
    projectFindUnique.mockImplementation(async () => {
      throw new Error('db down')
    })
    existsSyncMock.mockImplementation((p: string) => p === '/srv/ws/proj-1')
    const res = await makeApp({ workspacesDir: '/srv/ws' }).request(
      '/api/projects/proj-1/runtime/start',
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    expect(existsSyncMock).toHaveBeenCalledWith('/srv/ws/proj-1')
  })

  test('DB throws + no workspacesDir → 404', async () => {
    projectFindUnique.mockImplementation(async () => {
      throw new Error('db down')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('DB hit short-circuits the FS check (existsSync not consulted)', async () => {
    existsSyncMock.mockImplementation(() => false)
    await makeApp({ workspacesDir: '/srv/ws' }).request(
      '/api/projects/proj-1/runtime/start',
      { method: 'POST' },
    )
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})

// ─── POST /runtime/start ──────────────────────────────────────────────────

describe('POST /projects/:projectId/runtime/start', () => {
  test('host mode: returns success + runtime.url + port', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'host' as const,
      runtime: {
        status: 'running',
        url: 'http://127.0.0.1:8123',
        port: 8123,
        agentPort: 9123,
      },
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      projectId: 'proj-1',
      status: 'running',
      url: 'http://127.0.0.1:8123',
      port: 8123,
    })
  })

  test('vm mode: returns success + res.url + port=0', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'vm' as const,
      url: 'https://vm-proj-1.cluster.local',
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      projectId: 'proj-1',
      status: 'running',
      url: 'https://vm-proj-1.cluster.local',
      port: 0,
    })
  })

  test('k8s mode: returns success + res.url + port=0', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'k8s' as const,
      url: 'https://proj-1.shogo.app',
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect((await res.json()).url).toBe('https://proj-1.shogo.app')
  })

  test('forwards onVMPermanentlyDisabled: "throw" and logTag: "Runtime" to the helper', async () => {
    await makeApp().request('/api/projects/proj-1/runtime/start', { method: 'POST' })
    expect(resolveProjectPodUrlMock).toHaveBeenCalledWith('proj-1', {
      logTag: 'Runtime',
      onVMPermanentlyDisabled: 'throw',
      runtimeManager,
    })
  })

  test('VM isolation enabled + helper throws → 503 vm_pool_unavailable (no fallback)', async () => {
    process.env.SHOGO_VM_ISOLATION = 'true'
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('warm pool exhausted')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('vm_pool_unavailable')
  })

  test('VM isolation NOT enabled + helper throws → 500 start_failed (default path)', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('something else')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('start_failed')
    expect(body.error.message).toBe('something else')
  })

  test('start_failed falls back to default message when error has no .message', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw {} as any
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/start', {
      method: 'POST',
    })
    expect((await res.json()).error.message).toBe('Failed to start runtime')
  })
})

// ─── POST /runtime/stop ───────────────────────────────────────────────────

describe('POST /projects/:projectId/runtime/stop', () => {
  test('happy path returns success + status=stopped, calls runtimeManager.stop', async () => {
    const res = await makeApp().request('/api/projects/proj-1/runtime/stop', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      projectId: 'proj-1',
      status: 'stopped',
    })
    expect(rmStopMock).toHaveBeenCalledWith('proj-1')
  })

  test('does NOT call validateProject — stop is idempotent even for unknown projects', async () => {
    projectFindUnique.mockReset()
    await makeApp().request('/api/projects/proj-unknown/runtime/stop', {
      method: 'POST',
    })
    expect(projectFindUnique).not.toHaveBeenCalled()
  })

  test('500 stop_failed when runtimeManager.stop throws', async () => {
    rmStopMock.mockImplementation(async () => {
      throw new Error('SIGKILL failed')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/stop', {
      method: 'POST',
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('stop_failed')
    expect(body.error.message).toBe('SIGKILL failed')
  })

  test('500 stop_failed falls back to a default message when error has no .message', async () => {
    rmStopMock.mockImplementation(async () => {
      throw {} as any
    })
    const res = await makeApp().request('/api/projects/proj-99/runtime/stop', {
      method: 'POST',
    })
    expect((await res.json()).error.message).toContain('Failed to stop runtime for project proj-99')
  })
})

// ─── GET /runtime/status ──────────────────────────────────────────────────

describe('GET /projects/:projectId/runtime/status', () => {
  test('returns "stopped" + ready:false when runtimeManager.status returns null', async () => {
    rmStatusMock.mockImplementation(() => null as any)
    const res = await makeApp().request('/api/projects/proj-1/runtime/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      projectId: 'proj-1',
      status: 'stopped',
      ready: false,
      url: null,
      port: null,
      message: 'Runtime not started',
    })
  })

  test('running runtime → ready:true + message "Runtime ready"', async () => {
    rmStatusMock.mockImplementation(() => ({
      status: 'running',
      url: 'http://127.0.0.1:8000',
      port: 8000,
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/status')
    expect(await res.json()).toEqual({
      projectId: 'proj-1',
      status: 'running',
      ready: true,
      url: 'http://127.0.0.1:8000',
      port: 8000,
      message: 'Runtime ready',
    })
  })

  test('starting runtime → ready:false + interpolated message', async () => {
    rmStatusMock.mockImplementation(() => ({
      status: 'starting',
      url: 'http://127.0.0.1:8000',
      port: 8000,
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/status')
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.message).toBe('Runtime is starting')
  })

  test('error runtime → ready:false + interpolated message', async () => {
    rmStatusMock.mockImplementation(() => ({
      status: 'error',
      url: null,
      port: null,
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/status')
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.status).toBe('error')
    expect(body.message).toBe('Runtime is error')
  })

  test('does NOT call validateProject (cheap status endpoint)', async () => {
    projectFindUnique.mockReset()
    await makeApp().request('/api/projects/proj-1/runtime/status')
    expect(projectFindUnique).not.toHaveBeenCalled()
  })

  test('500 status_failed when runtimeManager.status throws', async () => {
    rmStatusMock.mockImplementation(() => {
      throw new Error('runtime registry corrupted')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/status')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('status_failed')
  })
})

// ─── GET /sandbox/url ─────────────────────────────────────────────────────

describe('GET /projects/:projectId/sandbox/url', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/sandbox/url')
    expect(res.status).toBe(404)
  })

  test('host mode happy path: returns url, directUrl, agentUrl, canvasBaseUrl, sandbox flags', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'host' as const,
      runtime: {
        status: 'running',
        url: 'http://127.0.0.1:8000',
        port: 8000,
        agentPort: 9000,
      },
    }))
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      url: 'http://127.0.0.1:8000',
      directUrl: 'http://127.0.0.1:8000',
      agentUrl: 'http://api.shogo.dev/api/projects/proj-1/agent-proxy',
      canvasBaseUrl: 'http://localhost:9000', // built from agentPort
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
      status: 'running',
      ready: true,
      message: 'Runtime ready',
    })
  })

  test('host mode + no agentPort: canvasBaseUrl falls back to runtime.url', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'host' as const,
      runtime: {
        status: 'running',
        url: 'http://127.0.0.1:8000',
        port: 8000,
        agentPort: 0, // falsy
      },
    }))
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    expect((await res.json()).canvasBaseUrl).toBe('http://127.0.0.1:8000')
  })

  test('agentUrl uses x-forwarded-proto when present', async () => {
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev', 'x-forwarded-proto': 'https' },
    })
    expect((await res.json()).agentUrl).toBe(
      'https://api.shogo.dev/api/projects/proj-1/agent-proxy',
    )
  })

  test('agentUrl falls back to localhost:<API_PORT> when Host header missing', async () => {
    process.env.API_PORT = '9876'
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url')
    expect((await res.json()).agentUrl).toBe(
      'http://localhost:9876/api/projects/proj-1/agent-proxy',
    )
    delete process.env.API_PORT
  })

  test('VM mode: url + canvasBaseUrl both point at res.url; message annotated', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'vm' as const,
      url: 'https://vm-proj-1.cluster.local',
    }))
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    const body = await res.json()
    expect(body.url).toBe('https://vm-proj-1.cluster.local')
    expect(body.directUrl).toBe('https://vm-proj-1.cluster.local')
    expect(body.canvasBaseUrl).toBe('https://vm-proj-1.cluster.local')
    expect(body.ready).toBe(true)
    expect(body.message).toBe('Runtime ready (VM)')
  })

  test('K8s mode: message annotated with "(K8s)"', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'k8s' as const,
      url: 'https://proj-1.k8s',
    }))
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    expect((await res.json()).message).toBe('Runtime ready (K8s)')
  })

  test('VM isolation enabled + helper throws → 503 with null url + vm_pool_unavailable', async () => {
    process.env.SHOGO_VM_ISOLATION = 'true'
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('vm pool dead')
    })
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.url).toBeNull()
    expect(body.status).toBe('starting')
    expect(body.ready).toBe(false)
    expect(body.error.code).toBe('vm_pool_unavailable')
  })

  test('default catch path: 500 sandbox_failed with url:null + status:error', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('unexpected error')
    })
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.url).toBeNull()
    expect(body.status).toBe('error')
    expect(body.ready).toBe(false)
    expect(body.error.code).toBe('sandbox_failed')
    expect(body.error.message).toBe('unexpected error')
  })

  test('non-running host runtime → ready:false and message "Runtime is starting"', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'host' as const,
      runtime: {
        status: 'starting',
        url: 'http://127.0.0.1:8000',
        port: 8000,
        agentPort: 9000,
      },
    }))
    const res = await makeApp().request('/api/projects/proj-1/sandbox/url', {
      headers: { host: 'api.shogo.dev' },
    })
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.message).toBe('Runtime is starting')
  })
})

// ─── POST /runtime/restart ────────────────────────────────────────────────

describe('POST /projects/:projectId/runtime/restart', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/runtime/restart', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('host mode (no VM, no K8s): calls stop() BEFORE re-resolving', async () => {
    // Sequence pin: stop must run before resolveProjectPodUrl so the
    // helper doesn\'t short-circuit on the already-running runtime.
    const calls: string[] = []
    rmStopMock.mockImplementation(async () => {
      calls.push('stop')
    })
    resolveProjectPodUrlMock.mockImplementation(async () => {
      calls.push('resolve')
      return {
        mode: 'host' as const,
        runtime: {
          status: 'running',
          url: 'http://127.0.0.1:8000',
          port: 8000,
          agentPort: 9000,
        },
      }
    })
    await makeApp().request('/api/projects/proj-1/runtime/restart', { method: 'POST' })
    expect(calls).toEqual(['stop', 'resolve'])
  })

  test('VM isolation enabled: does NOT call stop()', async () => {
    process.env.SHOGO_VM_ISOLATION = 'true'
    await makeApp().request('/api/projects/proj-1/runtime/restart', { method: 'POST' })
    expect(rmStopMock).not.toHaveBeenCalled()
  })

  test('K8s mode (KUBERNETES_SERVICE_HOST set): does NOT call stop()', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    await makeApp().request('/api/projects/proj-1/runtime/restart', { method: 'POST' })
    expect(rmStopMock).not.toHaveBeenCalled()
  })

  test('host mode happy path returns success + status + url + port', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'host' as const,
      runtime: {
        status: 'running',
        url: 'http://127.0.0.1:8000',
        port: 8000,
        agentPort: 9000,
      },
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/restart', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      projectId: 'proj-1',
      status: 'running',
      url: 'http://127.0.0.1:8000',
      port: 8000,
    })
  })

  test('VM mode: returns res.url + port=0', async () => {
    process.env.SHOGO_VM_ISOLATION = 'true'
    resolveProjectPodUrlMock.mockImplementation(async () => ({
      mode: 'vm' as const,
      url: 'https://vm.cluster',
    }))
    const res = await makeApp().request('/api/projects/proj-1/runtime/restart', {
      method: 'POST',
    })
    expect(await res.json()).toEqual({
      success: true,
      projectId: 'proj-1',
      status: 'running',
      url: 'https://vm.cluster',
      port: 0,
    })
  })

  test('VM isolation enabled + helper throws → 503 vm_pool_unavailable', async () => {
    process.env.SHOGO_VM_ISOLATION = 'true'
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('pool exhausted')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/restart', {
      method: 'POST',
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('vm_pool_unavailable')
  })

  test('default catch path: 500 restart_failed', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('unexpected')
    })
    const res = await makeApp().request('/api/projects/proj-1/runtime/restart', {
      method: 'POST',
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('restart_failed')
    expect(body.error.message).toBe('unexpected')
  })

  test('restart_failed falls back to per-project default message when error has no .message', async () => {
    resolveProjectPodUrlMock.mockImplementation(async () => {
      throw {} as any
    })
    const res = await makeApp().request('/api/projects/proj-9/runtime/restart', {
      method: 'POST',
    })
    expect((await res.json()).error.message).toContain(
      'Failed to restart runtime for project proj-9',
    )
  })
})

// ─── domainSuffix / config plumbing ───────────────────────────────────────

describe('runtimeRoutes config plumbing', () => {
  test('runtimeManager is forwarded into resolveProjectPodUrl options', async () => {
    await makeApp().request('/api/projects/proj-1/runtime/start', { method: 'POST' })
    expect(resolveProjectPodUrlMock.mock.calls[0][1].runtimeManager).toBe(runtimeManager)
  })
})
