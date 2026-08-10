// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/resolve-pod-url.ts — the single source of truth for
 * "where is project P's agent runtime?". This module's JSDoc explicitly
 * references `__tests__/resolve-pod-url.test.ts` as the test file that
 * should cover every branch.
 *
 * The helper exposes test-only overrides (`_k8sResolver`, `_isKubernetes`,
 * `runtimeManager`) so every branch is exercised without I/O.
 */

import { describe, expect, mock, test } from 'bun:test'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'
import type { IProjectRuntime, IRuntimeManager } from '../lib/runtime/types'

// ─── fakes ────────────────────────────────────────────────────────────────

function makeRuntime(overrides: Partial<IProjectRuntime> = {}): IProjectRuntime {
  return {
    projectId: 'proj-1',
    status: 'running',
    port: 8000,
    agentPort: 9000,
    url: 'http://127.0.0.1:8000',
    ...overrides,
  } as IProjectRuntime
}

function makeManager(opts: {
  status?: IProjectRuntime | null
  start?: IProjectRuntime
  startThrows?: Error
} = {}): {
  manager: IRuntimeManager
  statusMock: ReturnType<typeof mock>
  startMock: ReturnType<typeof mock>
  stopMock: ReturnType<typeof mock>
} {
  const statusMock = mock((_: string) => opts.status ?? null)
  const startMock = mock(async (_: string) => {
    if (opts.startThrows) throw opts.startThrows
    return opts.start ?? makeRuntime()
  })
  const stopMock = mock(async (_: string) => {})
  const manager = {
    status: statusMock,
    start: startMock,
    stop: stopMock,
  } as unknown as IRuntimeManager
  return { manager, statusMock, startMock, stopMock }
}

// ─── k8s branch ───────────────────────────────────────────────────────────

describe('k8s branch', () => {
  test('returns { mode: "k8s", url } from the injected resolver', async () => {
    const k8sResolver = mock(async (_: string) => 'http://api.svc.cluster.local')
    const result = await resolveProjectPodUrl('proj-k8s', {
      _isKubernetes: () => true,
      _k8sResolver: k8sResolver,
    })
    expect(result).toEqual({ mode: 'k8s', url: 'http://api.svc.cluster.local' })
    expect(k8sResolver).toHaveBeenCalledWith('proj-k8s')
    expect(k8sResolver).toHaveBeenCalledTimes(1)
  })

  test('does NOT consult the runtime manager when in k8s mode', async () => {
    const { manager, startMock, statusMock } = makeManager()
    await resolveProjectPodUrl('proj-k8s', {
      _isKubernetes: () => true,
      _k8sResolver: async () => 'http://k8s',
      runtimeManager: manager,
    })
    expect(startMock).not.toHaveBeenCalled()
    expect(statusMock).not.toHaveBeenCalled()
  })

  test('K8s resolver errors propagate (no silent host fallback)', async () => {
    const k8sResolver = mock(async (_: string) => { throw new Error('kube unreachable') })
    await expect(resolveProjectPodUrl('p', {
      _isKubernetes: () => true,
      _k8sResolver: k8sResolver,
    })).rejects.toThrow('kube unreachable')
  })
})

// ─── host branch ──────────────────────────────────────────────────────────

describe('host branch', () => {
  test('starts the runtime when status() returns null', async () => {
    const { manager, statusMock, startMock } = makeManager({
      status: null,
      start: makeRuntime({ url: 'http://127.0.0.1:8000', agentPort: 9000 }),
    })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect(statusMock).toHaveBeenCalledWith('proj-host')
    expect(startMock).toHaveBeenCalledWith('proj-host')
    expect(result.mode).toBe('host')
    expect((result as any).url).toBe('http://127.0.0.1:9000')
    expect((result as any).runtime).toBeDefined()
  })

  test('starts the runtime when status() is "stopped"', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'stopped' as any }),
      start: makeRuntime({ url: 'http://127.0.0.1:8000', agentPort: 9000 }),
    })
    await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  test('starts the runtime when status() is "error"', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'error' as any }),
      start: makeRuntime(),
    })
    await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  test('starts the runtime when status() lacks agentPort', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ agentPort: undefined as any }),
      start: makeRuntime({ url: 'http://127.0.0.1:8000', agentPort: 9123 }),
    })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
    expect((result as any).url).toBe('http://127.0.0.1:9123')
  })

  test('reuses a running runtime without calling start()', async () => {
    const existing = makeRuntime({
      status: 'running',
      url: 'http://127.0.0.1:8000',
      agentPort: 9000,
    })
    const { manager, startMock } = makeManager({ status: existing })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect(startMock).not.toHaveBeenCalled()
    expect((result as any).url).toBe('http://127.0.0.1:9000')
    expect((result as any).runtime).toBe(existing)
  })

  test('uses runtime.url hostname (not the literal url) when building agent URL', async () => {
    const { manager } = makeManager({
      status: makeRuntime({
        status: 'running',
        url: 'http://10.20.30.40:8000/some/path',
        agentPort: 9500,
      }),
    })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://10.20.30.40:9500')
  })

  test('falls back to host=localhost when runtime.url is not a valid URL', async () => {
    const { manager } = makeManager({
      status: makeRuntime({
        status: 'running',
        url: 'not-a-url',
        agentPort: 9999,
      }),
    })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://localhost:9999')
  })

  test('falls back to host=localhost when runtime.url is missing entirely', async () => {
    const { manager } = makeManager({
      status: makeRuntime({
        status: 'running',
        url: undefined as any,
        agentPort: 9999,
      }),
    })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://localhost:9999')
  })

  test('derives agentPort from port + 1000 when agentPort is missing on a running runtime', async () => {
    const startedRuntime = makeRuntime({
      status: 'running',
      url: 'http://127.0.0.1:8000',
      port: 8000,
      agentPort: undefined as any,
    })
    const { manager } = makeManager({ start: startedRuntime })
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://127.0.0.1:9000')
  })
})

// ─── env defaults ─────────────────────────────────────────────────────────

describe('env-driven defaults', () => {
  test('defaults: no KUBERNETES_SERVICE_HOST → host mode', async () => {
    const savedK = process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_HOST
    try {
      const { manager } = makeManager({ status: makeRuntime() })
      const result = await resolveProjectPodUrl('proj-env', { runtimeManager: manager })
      expect(result.mode).toBe('host')
    } finally {
      if (savedK !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedK
    }
  })

  test('KUBERNETES_SERVICE_HOST set → k8s mode (via dynamic import path)', async () => {
    // We cannot exercise the dynamic import here without mocking the
    // module loader, so we override _k8sResolver and only let the env
    // probe run with its default implementation.
    const saved = process.env.KUBERNETES_SERVICE_HOST
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    try {
      const k8sResolver = mock(async (_: string) => 'http://api.k8s')
      const result = await resolveProjectPodUrl('proj-env-k8s', {
        _k8sResolver: k8sResolver,
      })
      expect(result.mode).toBe('k8s')
      expect(k8sResolver).toHaveBeenCalledWith('proj-env-k8s')
    } finally {
      if (saved === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = saved
    }
  })
})

// ─── logTag plumbing ──────────────────────────────────────────────────────

describe('logTag plumbing', () => {
  test('uses provided logTag in fallback warning', async () => {
    const { manager } = makeManager({ start: makeRuntime() })
    const warnCalls: string[] = []
    const warn = console.warn
    console.warn = (...args: any[]) => warnCalls.push(args.join(' '))
    try {
      await resolveProjectPodUrl('p', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => { throw new Error('metal down') },
        _isKubernetes: () => false,
        runtimeManager: manager,
        logTag: 'AgentProxy',
      })
      expect(warnCalls.join('\n')).toContain('[AgentProxy]')
    } finally {
      console.warn = warn
    }
  })
})

// ──────────────────────────────────────────────────────────────────────
// Extended coverage — defensive edges & invariants
// (added in tests/backend-unit-coverage)
// ──────────────────────────────────────────────────────────────────────

describe('host branch — URL parsing edge cases', () => {
  test('runtime.url with explicit port keeps the URL.hostname (port comes from agentPort)', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: 'http://10.0.0.5:8765', agentPort: 9100, port: 8765 }),
    })
    const res = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(res).toEqual({
      mode: 'host', url: 'http://10.0.0.5:9100',
      runtime: expect.objectContaining({ agentPort: 9100 }),
    } as any)
  })

  test('IPv4 hostname preserved (not localhost)', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: 'http://192.168.1.42:8000', agentPort: 9001 }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://192.168.1.42:9001')
  })

  test('non-URL runtime.url string falls back to localhost without throwing', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: 'not://a valid url' as any, agentPort: 9002 }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:9002')
  })

  test('missing runtime.url falls back to localhost', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: undefined as any, agentPort: 9003 }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:9003')
  })

  test('missing agentPort derives agent port as port + 1000', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ port: 7777, agentPort: undefined as any, url: 'http://localhost:7777' }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:8777')
  })

  test('error-status runtime triggers a fresh manager.start() call', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'error', agentPort: 0 }),
      start: makeRuntime({ status: 'running', agentPort: 9090, url: 'http://localhost:8000' }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalled()
    expect(res.url).toBe('http://localhost:9090')
  })

  test('stopped-status runtime triggers a fresh manager.start() call', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'stopped', agentPort: 0 }),
      start: makeRuntime({ status: 'running', agentPort: 9099, url: 'http://localhost:8000' }),
    })
    await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  test('running-status runtime with agentPort=0 (falsy) triggers a fresh start', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'running', agentPort: 0 }),
      start: makeRuntime({ agentPort: 9100, url: 'http://localhost:8000' }),
    })
    await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })
})

describe('default mode probes', () => {
  test('defaultIsKubernetes reads KUBERNETES_SERVICE_HOST', async () => {
    const prev = process.env.KUBERNETES_SERVICE_HOST
    try {
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
      const k8sResolver = mock(async (_: string) => 'http://k8s-default')
      const res = await resolveProjectPodUrl('p', {
        _k8sResolver: k8sResolver,
        // intentionally omit _isKubernetes to exercise the default
      })
      expect(res.mode).toBe('k8s')
    } finally {
      if (prev === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = prev
    }
  })
})
