// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/resolve-pod-url.ts — the single source of truth for
 * "where is project P's agent runtime?". This module's JSDoc explicitly
 * references `__tests__/resolve-pod-url.test.ts` as the test file that
 * should cover every branch. Until now it didn't exist.
 *
 * The helper exposes test-only overrides (`_k8sResolver`, `_vmResolver`,
 * `_isKubernetes`, `_isVMIsolation`, `_vmPoolPermanentlyDisabledError`,
 * `runtimeManager`) so every branch is exercised without I/O.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'
import type { IProjectRuntime, IRuntimeManager } from '../lib/runtime/types'

// ─── fakes ────────────────────────────────────────────────────────────────

class FakeVMPoolPermanentlyDisabledError extends Error {
  consecutiveFailures: number
  constructor(consecutiveFailures = 7) {
    super('VM pool disabled')
    this.name = 'VMPoolPermanentlyDisabledError'
    this.consecutiveFailures = consecutiveFailures
  }
}

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

beforeEach(() => {
  // no-op — every test wires its own overrides
})

// ─── k8s branch ───────────────────────────────────────────────────────────

describe('k8s branch', () => {
  test('returns { mode: "k8s", url } from the injected resolver', async () => {
    const k8sResolver = mock(async (_: string) => 'http://api.svc.cluster.local')
    const result = await resolveProjectPodUrl('proj-k8s', {
      _isKubernetes: () => true,
      _isVMIsolation: () => false,
      _k8sResolver: k8sResolver,
    })
    expect(result).toEqual({ mode: 'k8s', url: 'http://api.svc.cluster.local' })
    expect(k8sResolver).toHaveBeenCalledWith('proj-k8s')
    expect(k8sResolver).toHaveBeenCalledTimes(1)
  })

  test('k8s wins even when VM isolation is also "on"', async () => {
    const k8sResolver = mock(async (_: string) => 'http://k8s.example')
    const vmResolver = mock(async (_: string) => 'http://vm.example')
    const result = await resolveProjectPodUrl('proj-x', {
      _isKubernetes: () => true,
      _isVMIsolation: () => true, // K8s should short-circuit before VM check
      _k8sResolver: k8sResolver,
      _vmResolver: vmResolver,
    })
    expect(result.mode).toBe('k8s')
    expect(vmResolver).not.toHaveBeenCalled()
  })

  test('does NOT consult the runtime manager when in k8s mode', async () => {
    const { manager, startMock, statusMock } = makeManager()
    await resolveProjectPodUrl('proj-k8s', {
      _isKubernetes: () => true,
      _isVMIsolation: () => false,
      _k8sResolver: async () => 'http://k8s',
      runtimeManager: manager,
    })
    expect(startMock).not.toHaveBeenCalled()
    expect(statusMock).not.toHaveBeenCalled()
  })
})

// ─── vm branch ────────────────────────────────────────────────────────────

describe('vm branch — happy path', () => {
  test('returns { mode: "vm", url } on first attempt', async () => {
    const vmResolver = mock(async (_: string) => 'http://vm-1.local')
    const result = await resolveProjectPodUrl('proj-vm', {
      _isKubernetes: () => false,
      _isVMIsolation: () => true,
      _vmResolver: vmResolver,
    })
    expect(result).toEqual({ mode: 'vm', url: 'http://vm-1.local' })
    expect(vmResolver).toHaveBeenCalledTimes(1)
  })
})

describe('vm branch — transient retry loop', () => {
  test('retries up to maxVMRetries, then succeeds', async () => {
    let calls = 0
    const vmResolver = mock(async (_: string) => {
      calls++
      if (calls < 3) throw new Error('warm pool not ready')
      return 'http://vm-ready'
    })
    const result = await resolveProjectPodUrl('proj-vm', {
      _isKubernetes: () => false,
      _isVMIsolation: () => true,
      _vmResolver: vmResolver,
      maxVMRetries: 5,
      vmRetryDelayMs: 0,
    })
    expect(result).toEqual({ mode: 'vm', url: 'http://vm-ready' })
    expect(vmResolver).toHaveBeenCalledTimes(3)
  })

  test('throws the last transient error when retry budget is exhausted', async () => {
    const vmResolver = mock(async (_: string) => {
      throw new Error('still not ready')
    })
    await expect(
      resolveProjectPodUrl('proj-vm', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: vmResolver,
        maxVMRetries: 3,
        vmRetryDelayMs: 0,
      }),
    ).rejects.toThrow('still not ready')
    expect(vmResolver).toHaveBeenCalledTimes(3)
  })

  test('default behaviour is no retry (single attempt)', async () => {
    const vmResolver = mock(async (_: string) => {
      throw new Error('first failure')
    })
    await expect(
      resolveProjectPodUrl('proj-vm', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: vmResolver,
      }),
    ).rejects.toThrow('first failure')
    expect(vmResolver).toHaveBeenCalledTimes(1)
  })

  test('maxVMRetries < 1 is clamped to 1 (single attempt)', async () => {
    const vmResolver = mock(async (_: string) => {
      throw new Error('fail')
    })
    await expect(
      resolveProjectPodUrl('proj-vm', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: vmResolver,
        maxVMRetries: 0,
      }),
    ).rejects.toThrow('fail')
    expect(vmResolver).toHaveBeenCalledTimes(1)
  })

  test('honours vmRetryDelayMs between attempts', async () => {
    let calls = 0
    const vmResolver = mock(async (_: string) => {
      calls++
      if (calls < 2) throw new Error('try again')
      return 'http://vm'
    })
    const start = Date.now()
    await resolveProjectPodUrl('proj-vm', {
      _isKubernetes: () => false,
      _isVMIsolation: () => true,
      _vmResolver: vmResolver,
      maxVMRetries: 2,
      vmRetryDelayMs: 50,
    })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40) // ≥ ~50ms with scheduler slack
  })
})

describe('vm branch — permanently-disabled error', () => {
  test('default onVMPermanentlyDisabled rethrows (no fallback)', async () => {
    const permanentErr = new FakeVMPoolPermanentlyDisabledError(5)
    const vmResolver = mock(async (_: string) => {
      throw permanentErr
    })
    await expect(
      resolveProjectPodUrl('proj-vm', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: vmResolver,
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        maxVMRetries: 5, // retry budget irrelevant — permanent errors short-circuit
      }),
    ).rejects.toBe(permanentErr)
    expect(vmResolver).toHaveBeenCalledTimes(1)
  })

  test('explicit onVMPermanentlyDisabled: "throw" also rethrows', async () => {
    const permanentErr = new FakeVMPoolPermanentlyDisabledError(9)
    await expect(
      resolveProjectPodUrl('proj-vm', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => {
          throw permanentErr
        },
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        onVMPermanentlyDisabled: 'throw',
      }),
    ).rejects.toBe(permanentErr)
  })

  test('onVMPermanentlyDisabled: "fallback-to-host" falls through to host runtime', async () => {
    const { manager, startMock } = makeManager({
      start: makeRuntime({ url: 'http://10.0.0.5:8000', agentPort: 9001 }),
    })
    const warn = console.warn
    const warnCalls: any[] = []
    console.warn = (...args: any[]) => warnCalls.push(args.join(' '))
    try {
      const result = await resolveProjectPodUrl('proj-vm-fb', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => {
          throw new FakeVMPoolPermanentlyDisabledError(11)
        },
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        onVMPermanentlyDisabled: 'fallback-to-host',
        runtimeManager: manager,
        logTag: 'Test',
      })
      expect(result.mode).toBe('host')
      expect((result as any).url).toBe('http://10.0.0.5:9001')
      expect(startMock).toHaveBeenCalledWith('proj-vm-fb')
      const joined = warnCalls.join('\n')
      expect(joined).toContain('[Test]')
      expect(joined).toContain('permanently disabled')
      expect(joined).toContain('11') // consecutiveFailures interpolated
      expect(joined).toContain('proj-vm-fb')
    } finally {
      console.warn = warn
    }
  })

  test('fallback-to-host warning says "unknown" when consecutiveFailures is missing', async () => {
    const { manager } = makeManager({ start: makeRuntime() })
    const warn = console.warn
    const warnCalls: any[] = []
    console.warn = (...args: any[]) => warnCalls.push(args.join(' '))
    try {
      const err = new FakeVMPoolPermanentlyDisabledError()
      delete (err as any).consecutiveFailures
      await resolveProjectPodUrl('proj-vm-fb', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => {
          throw err
        },
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        onVMPermanentlyDisabled: 'fallback-to-host',
        runtimeManager: manager,
      })
      expect(warnCalls.join('\n')).toContain('(unknown boot failures)')
    } finally {
      console.warn = warn
    }
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://localhost:9999')
  })

  test('derives agentPort from port + 1000 when agentPort is missing on a running runtime', async () => {
    const { manager } = makeManager({
      status: makeRuntime({
        status: 'running',
        url: 'http://127.0.0.1:8000',
        port: 8000,
        agentPort: undefined as any,
      }),
    })
    // Note: with no agentPort, the helper actually starts a fresh runtime
    // (see the "lacks agentPort" branch test above). To exercise the
    // `runtime.port + 1000` fallback we feed it via start() result.
    const startedRuntime = makeRuntime({
      status: 'running',
      url: 'http://127.0.0.1:8000',
      port: 8000,
      agentPort: undefined as any,
    })
    ;(manager.start as any).mockImplementation(async () => startedRuntime)
    const result = await resolveProjectPodUrl('proj-host', {
      _isKubernetes: () => false,
      _isVMIsolation: () => false,
      runtimeManager: manager,
    })
    expect((result as any).url).toBe('http://127.0.0.1:9000')
  })
})

// ─── env defaults ─────────────────────────────────────────────────────────

describe('env-driven defaults', () => {
  test('defaults: no KUBERNETES_SERVICE_HOST + no SHOGO_VM_ISOLATION → host mode', async () => {
    const savedK = process.env.KUBERNETES_SERVICE_HOST
    const savedV = process.env.SHOGO_VM_ISOLATION
    delete process.env.KUBERNETES_SERVICE_HOST
    delete process.env.SHOGO_VM_ISOLATION
    try {
      const { manager } = makeManager({ status: makeRuntime() })
      const result = await resolveProjectPodUrl('proj-env', { runtimeManager: manager })
      expect(result.mode).toBe('host')
    } finally {
      if (savedK !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedK
      if (savedV !== undefined) process.env.SHOGO_VM_ISOLATION = savedV
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

  test('SHOGO_VM_ISOLATION="true" alone → vm mode', async () => {
    const savedK = process.env.KUBERNETES_SERVICE_HOST
    const savedV = process.env.SHOGO_VM_ISOLATION
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.SHOGO_VM_ISOLATION = 'true'
    try {
      const vmResolver = mock(async (_: string) => 'http://vm-env')
      const result = await resolveProjectPodUrl('proj-env-vm', {
        _vmResolver: vmResolver,
      })
      expect(result.mode).toBe('vm')
      expect((result as any).url).toBe('http://vm-env')
    } finally {
      if (savedK !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedK
      if (savedV === undefined) delete process.env.SHOGO_VM_ISOLATION
      else process.env.SHOGO_VM_ISOLATION = savedV
    }
  })

  test('SHOGO_VM_ISOLATION other than "true" is treated as off', async () => {
    const savedK = process.env.KUBERNETES_SERVICE_HOST
    const savedV = process.env.SHOGO_VM_ISOLATION
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.SHOGO_VM_ISOLATION = '1' // not exactly "true"
    try {
      const { manager } = makeManager({ status: makeRuntime() })
      const vmResolver = mock(async (_: string) => 'http://vm-should-not-be-called')
      const result = await resolveProjectPodUrl('proj-env-vm-off', {
        runtimeManager: manager,
        _vmResolver: vmResolver,
      })
      expect(result.mode).toBe('host')
      expect(vmResolver).not.toHaveBeenCalled()
    } finally {
      if (savedK !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedK
      if (savedV === undefined) delete process.env.SHOGO_VM_ISOLATION
      else process.env.SHOGO_VM_ISOLATION = savedV
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
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => {
          throw new FakeVMPoolPermanentlyDisabledError(3)
        },
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        onVMPermanentlyDisabled: 'fallback-to-host',
        runtimeManager: manager,
        logTag: 'AgentProxy',
      })
      expect(warnCalls.join('\n')).toContain('[AgentProxy]')
    } finally {
      console.warn = warn
    }
  })

  test('uses provided logTag in transient-retry log line', async () => {
    let calls = 0
    const vmResolver = mock(async (_: string) => {
      calls++
      if (calls < 2) throw new Error('not yet')
      return 'http://vm'
    })
    const logCalls: string[] = []
    const log = console.log
    console.log = (...args: any[]) => logCalls.push(args.join(' '))
    try {
      await resolveProjectPodUrl('p', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: vmResolver,
        maxVMRetries: 2,
        vmRetryDelayMs: 0,
        logTag: 'ProjectChat',
      })
      expect(logCalls.join('\n')).toContain('[ProjectChat]')
      expect(logCalls.join('\n')).toContain('attempt 1/2')
    } finally {
      console.log = log
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
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
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
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://192.168.1.42:9001')
  })

  test('non-URL runtime.url string falls back to localhost without throwing', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: 'not://a valid url' as any, agentPort: 9002 }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:9002')
  })

  test('missing runtime.url falls back to localhost', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ url: undefined as any, agentPort: 9003 }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:9003')
  })

  test('missing agentPort derives agent port as port + 1000', async () => {
    const { manager } = makeManager({
      start: makeRuntime({ port: 7777, agentPort: undefined as any, url: 'http://localhost:7777' }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(res.url).toBe('http://localhost:8777')
  })

  test('error-status runtime triggers a fresh manager.start() call', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'error', agentPort: 0 }),
      start: makeRuntime({ status: 'running', agentPort: 9090, url: 'http://localhost:8000' }),
    })
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
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
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  test('running-status runtime with agentPort=0 (falsy) triggers a fresh start', async () => {
    const { manager, startMock } = makeManager({
      status: makeRuntime({ status: 'running', agentPort: 0 }),
      start: makeRuntime({ agentPort: 9100, url: 'http://localhost:8000' }),
    })
    await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => false, runtimeManager: manager,
    })
    expect(startMock).toHaveBeenCalledTimes(1)
  })
})

describe('VM branch — defensive edges', () => {
  test('maxVMRetries < 1 is clamped to 1 (no infinite-budget bug)', async () => {
    const vmResolver = mock(async (_: string) => { throw new Error('transient') })
    await expect(resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => true,
      _vmResolver: vmResolver, _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
      maxVMRetries: 0,
    })).rejects.toThrow('transient')
    expect(vmResolver).toHaveBeenCalledTimes(1)
  })

  test('non-Error rejection still propagates after retry budget exhausted', async () => {
    const vmResolver = mock(async (_: string) => { throw 'string error' as unknown as Error })
    await expect(resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => true,
      _vmResolver: vmResolver, _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
      maxVMRetries: 2, vmRetryDelayMs: 0,
    })).rejects.toBe('string error')
    expect(vmResolver).toHaveBeenCalledTimes(2)
  })

  test('zero retry delay does not call setTimeout (synchronous retry path)', async () => {
    let attempts = 0
    const vmResolver = mock(async (_: string) => {
      attempts++
      if (attempts < 3) throw new Error('transient')
      return 'http://vm.local:8000'
    })
    const t0 = Date.now()
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => false, _isVMIsolation: () => true,
      _vmResolver: vmResolver, _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
      maxVMRetries: 3, vmRetryDelayMs: 0,
    })
    expect(res.mode).toBe('vm')
    expect(Date.now() - t0).toBeLessThan(50) // no delay incurred
    expect(attempts).toBe(3)
  })
})

describe('K8s branch — defensive edges', () => {
  test('K8s takes priority over VM_ISOLATION when both flags are true', async () => {
    const k8sResolver = mock(async (_: string) => 'http://from-k8s')
    const vmResolver = mock(async (_: string) => 'http://from-vm')
    const res = await resolveProjectPodUrl('p', {
      _isKubernetes: () => true, _isVMIsolation: () => true,
      _k8sResolver: k8sResolver, _vmResolver: vmResolver,
    })
    expect(res.url).toBe('http://from-k8s')
    expect(vmResolver).not.toHaveBeenCalled()
  })

  test('K8s resolver errors propagate (no silent host fallback)', async () => {
    const k8sResolver = mock(async (_: string) => { throw new Error('kube unreachable') })
    await expect(resolveProjectPodUrl('p', {
      _isKubernetes: () => true, _isVMIsolation: () => false,
      _k8sResolver: k8sResolver,
    })).rejects.toThrow('kube unreachable')
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
        _isVMIsolation: () => false,
      })
      expect(res.mode).toBe('k8s')
    } finally {
      if (prev === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = prev
    }
  })

  test('defaultIsVMIsolation reads SHOGO_VM_ISOLATION === "true" (string match, not boolean coerce)', async () => {
    const prev = process.env.SHOGO_VM_ISOLATION
    try {
      process.env.SHOGO_VM_ISOLATION = '1' // truthy but not the literal "true"
      const { manager } = makeManager({ start: makeRuntime({ agentPort: 9050 }) })
      const res = await resolveProjectPodUrl('p', {
        _isKubernetes: () => false,
        // intentionally omit _isVMIsolation to exercise the default
        runtimeManager: manager,
      })
      expect(res.mode).toBe('host') // SHOGO_VM_ISOLATION='1' is rejected, falls to host
    } finally {
      if (prev === undefined) delete process.env.SHOGO_VM_ISOLATION
      else process.env.SHOGO_VM_ISOLATION = prev
    }
  })
})
