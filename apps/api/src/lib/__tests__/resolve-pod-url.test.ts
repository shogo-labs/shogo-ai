// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, it, mock, test } from 'bun:test'
import { resolveProjectPodUrl, type ResolvePodUrlOpts } from '../resolve-pod-url'

class FakeVMPoolPermanentlyDisabledError extends Error {
  constructor(public consecutiveFailures: number = 3) {
    super(`VM warm pool permanently disabled (${consecutiveFailures} failures)`)
    this.name = 'VMPoolPermanentlyDisabledError'
  }
}

function fakeRuntime(overrides: Partial<any> = {}) {
  return {
    projectId: 'proj-1',
    port: 37500,
    agentPort: 38500,
    status: 'running' as const,
    url: 'http://localhost:37500',
    pid: 12345,
    startedAt: Date.now(),
    ...overrides,
  }
}

function fakeRuntimeManager(initial?: any) {
  let runtime = initial
  return {
    status: () => runtime,
    start: mock(async () => {
      runtime = fakeRuntime()
      return runtime
    }),
    _setRuntime(r: any) { runtime = r },
  }
}

describe('resolveProjectPodUrl', () => {
  describe('mode selection', () => {
    it('routes K8s when isKubernetes()', async () => {
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => true,
        _isVMIsolation: () => false,
        _k8sResolver: async () => 'http://pod.example/v1',
      })
      expect(res).toEqual({ mode: 'k8s', url: 'http://pod.example/v1' })
    })

    it('routes VM when SHOGO_VM_ISOLATION=true and K8s is off', async () => {
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => 'http://localhost:39200',
      })
      expect(res).toEqual({ mode: 'vm', url: 'http://localhost:39200' })
    })

    it('routes host when neither isolation flag is set', async () => {
      const mgr = fakeRuntimeManager(fakeRuntime())
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('host')
      expect(res.url).toBe('http://localhost:38500')
      expect((res as any).runtime).toBeDefined()
    })

    it('K8s wins over VM if both env flags are set (matches existing precedence)', async () => {
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => true,
        _isVMIsolation: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
        _vmResolver: async () => 'http://localhost:39200',
      })
      expect(res.mode).toBe('k8s')
    })
  })

  describe('metal substrate routing', () => {
    it('routes metal when enabled and the project is eligible (wins over k8s)', async () => {
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => 'http://10.8.0.2:8080',
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
      })
      expect(res).toEqual({ mode: 'metal', url: 'http://10.8.0.2:8080' })
    })

    it('does NOT touch metal when the project is ineligible', async () => {
      let metalCalls = 0
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => false,
        _metalResolver: async () => { metalCalls++; return 'http://metal' },
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
      })
      expect(metalCalls).toBe(0)
      expect(res.mode).toBe('k8s')
    })

    it('falls back to k8s when the metal resolver throws (best-effort)', async () => {
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => { throw new Error('no live metal host available') },
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
      })
      expect(res).toEqual({ mode: 'k8s', url: 'http://pod.cluster/v1' })
    })

    it('falls back to host when metal fails and no k8s/VM isolation', async () => {
      const mgr = fakeRuntimeManager()
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => { throw new Error('all metal hosts failed') },
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('host')
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })
  })

  describe('metal-only mode (SHOGO_METAL_ALL_PROJECTS)', () => {
    it('routes every project to metal', async () => {
      const res = await resolveProjectPodUrl('any-proj', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _isMetalOnly: () => true,
        _metalResolver: async () => 'http://10.8.0.2:8080',
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
      })
      expect(res).toEqual({ mode: 'metal', url: 'http://10.8.0.2:8080' })
    })

    it('does NOT fall back to k8s when metal fails — throws a retryable "starting" error', async () => {
      let k8sCalls = 0
      await expect(
        resolveProjectPodUrl('any-proj', {
          _isMetalEnabled: () => true,
          _isMetalEligible: () => true,
          _isMetalOnly: () => true,
          _metalResolver: async () => { throw new Error('no live metal host available') },
          _isKubernetes: () => true,
          _k8sResolver: async () => { k8sCalls++; return 'http://pod.cluster/v1' },
        }),
      ).rejects.toThrow(/starting/)
      expect(k8sCalls).toBe(0)
    })

    it('does NOT fall back to host when metal fails in metal-only mode', async () => {
      const mgr = fakeRuntimeManager()
      await expect(
        resolveProjectPodUrl('any-proj', {
          _isMetalEnabled: () => true,
          _isMetalEligible: () => true,
          _isMetalOnly: () => true,
          _metalResolver: async () => { throw new Error('all metal hosts failed') },
          _isKubernetes: () => false,
          _isVMIsolation: () => false,
          runtimeManager: mgr as any,
        }),
      ).rejects.toThrow(/metal-only/)
      expect(mgr.start).toHaveBeenCalledTimes(0)
    })
  })

  describe('metal wait-and-retry (metalWaitMs)', () => {
    it('does a SINGLE attempt by default (metalWaitMs unset) then falls back', async () => {
      let metalCalls = 0
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => { metalCalls++; throw new Error('not ready') },
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
      })
      expect(metalCalls).toBe(1)
      expect(res.mode).toBe('k8s')
    })

    it('rejoins the in-flight wake: retries within the budget and succeeds on a later attempt', async () => {
      let calls = 0
      const res = await resolveProjectPodUrl('proj-1', {
        _isMetalEnabled: () => true,
        _isMetalEligible: () => true,
        _metalResolver: async () => {
          calls++
          if (calls < 3) throw new Error('metal /assign timed out')
          return 'http://10.8.0.2:8080'
        },
        _isKubernetes: () => true,
        _k8sResolver: async () => 'http://pod.cluster/v1',
        metalWaitMs: 5000,
        metalRetryDelayMs: 1,
      })
      expect(calls).toBe(3)
      expect(res).toEqual({ mode: 'metal', url: 'http://10.8.0.2:8080' })
    })

    it('metal-only: retries within budget, then throws a retryable "starting" error (no k8s fallback)', async () => {
      let calls = 0
      let k8sCalls = 0
      await expect(
        resolveProjectPodUrl('any-proj', {
          _isMetalEnabled: () => true,
          _isMetalEligible: () => true,
          _isMetalOnly: () => true,
          _metalResolver: async () => { calls++; throw new Error('no live metal host available') },
          _isKubernetes: () => true,
          _k8sResolver: async () => { k8sCalls++; return 'http://pod.cluster/v1' },
          metalWaitMs: 20,
          metalRetryDelayMs: 1,
        }),
      ).rejects.toThrow(/metal-only/)
      expect(calls).toBeGreaterThan(1) // retried at least once before giving up
      expect(k8sCalls).toBe(0)
    })
  })

  describe('VM transient failure handling', () => {
    it('throws the transient error by default (maxVMRetries=1)', async () => {
      await expect(
        resolveProjectPodUrl('proj-1', {
          _isKubernetes: () => false,
          _isVMIsolation: () => true,
          _vmResolver: async () => { throw new Error('transient: pool warming up') },
        }),
      ).rejects.toThrow(/transient/)
    })

    it('retries up to maxVMRetries times before throwing', async () => {
      let calls = 0
      await expect(
        resolveProjectPodUrl('proj-1', {
          _isKubernetes: () => false,
          _isVMIsolation: () => true,
          maxVMRetries: 3,
          vmRetryDelayMs: 0,
          _vmResolver: async () => {
            calls++
            throw new Error('transient')
          },
        }),
      ).rejects.toThrow(/transient/)
      expect(calls).toBe(3)
    })

    it('succeeds on a later attempt if VM becomes ready', async () => {
      let calls = 0
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        maxVMRetries: 5,
        vmRetryDelayMs: 0,
        _vmResolver: async () => {
          calls++
          if (calls < 3) throw new Error('transient')
          return 'http://localhost:39200'
        },
      })
      expect(res).toEqual({ mode: 'vm', url: 'http://localhost:39200' })
      expect(calls).toBe(3)
    })

    it('does NOT retry on VMPoolPermanentlyDisabledError', async () => {
      let calls = 0
      await expect(
        resolveProjectPodUrl('proj-1', {
          _isKubernetes: () => false,
          _isVMIsolation: () => true,
          maxVMRetries: 5,
          vmRetryDelayMs: 0,
          _vmResolver: async () => {
            calls++
            throw new FakeVMPoolPermanentlyDisabledError(3)
          },
          _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
          onVMPermanentlyDisabled: 'throw',
        }),
      ).rejects.toThrow(/permanently disabled/)
      expect(calls).toBe(1)
    })
  })

  describe('VM permanent-disable fallback policy', () => {
    it("'throw' rethrows VMPoolPermanentlyDisabledError without touching host", async () => {
      const mgr = fakeRuntimeManager()
      await expect(
        resolveProjectPodUrl('proj-1', {
          _isKubernetes: () => false,
          _isVMIsolation: () => true,
          _vmResolver: async () => { throw new FakeVMPoolPermanentlyDisabledError(3) },
          _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
          onVMPermanentlyDisabled: 'throw',
          runtimeManager: mgr as any,
        }),
      ).rejects.toThrow()
      expect(mgr.start).toHaveBeenCalledTimes(0)
    })

    it("'fallback-to-host' switches to host RuntimeManager after permanent disable", async () => {
      const mgr = fakeRuntimeManager()
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => { throw new FakeVMPoolPermanentlyDisabledError(3) },
        _vmPoolPermanentlyDisabledError: FakeVMPoolPermanentlyDisabledError,
        onVMPermanentlyDisabled: 'fallback-to-host',
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('host')
      expect(res.url).toBe('http://localhost:38500')
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })
  })

  describe('host mode runtime reuse', () => {
    it('does NOT call manager.start when runtime is already running', async () => {
      const running = fakeRuntime({ status: 'running' })
      const mgr = fakeRuntimeManager(running)
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('host')
      expect((res as any).runtime).toBe(running)
      expect(mgr.start).toHaveBeenCalledTimes(0)
    })

    it('calls manager.start when status is stopped', async () => {
      const stopped = fakeRuntime({ status: 'stopped' })
      const mgr = fakeRuntimeManager(stopped)
      await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })

    it('calls manager.start when status is error', async () => {
      const errored = fakeRuntime({ status: 'error' })
      const mgr = fakeRuntimeManager(errored)
      await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })

    it('calls manager.start when no runtime exists', async () => {
      const mgr = fakeRuntimeManager(undefined)
      await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })

    it('calls manager.start when runtime exists but agentPort is missing (interrupted boot)', async () => {
      const halfBaked = { ...fakeRuntime(), agentPort: undefined }
      const mgr = fakeRuntimeManager(halfBaked)
      await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(mgr.start).toHaveBeenCalledTimes(1)
    })

    it('calls manager.start when status is starting (joins inflight prewarm)', async () => {
      // Regression: the home composer fires `POST /runtime/prewarm` which
      // allocates `agentPort` synchronously and sets `status: 'starting'`
      // long before Vite + the agent-runtime are listening. A previous
      // gate of "agentPort set & status !== stopped/error" would skip the
      // await and let `/sandbox/url` return URLs the runtime wasn't
      // listening on yet — ECONNREFUSED on the canvas / preview iframe /
      // agent SSE. `manager.start()` dedupes via `startingPromises`, so
      // calling it here joins the inflight start instead of triggering a
      // second spawn.
      const starting = fakeRuntime({ status: 'starting' })
      const mgr = fakeRuntimeManager(starting)
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(mgr.start).toHaveBeenCalledTimes(1)
      expect(res.mode).toBe('host')
      // start() resolves to a `running` runtime (see fakeRuntimeManager),
      // so the resolved URL reflects the now-ready agent port.
      expect(res.url).toBe('http://localhost:38500')
    })

    it('falls back to runtime.port+1000 when agentPort is set later but undefined now', async () => {
      // Captures the legacy convention `agentPort ?? port + 1000`.
      const mgr = fakeRuntimeManager()
      mgr.start = mock(async () => fakeRuntime({ agentPort: undefined as any, port: 37500 })) as any
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('host')
      expect(res.url).toBe('http://localhost:38500') // 37500 + 1000
    })

    it('reuses the hostname from runtime.url so non-localhost host bindings still work', async () => {
      const mgr = fakeRuntimeManager(fakeRuntime({ url: 'http://0.0.0.0:37500' }))
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => false,
        runtimeManager: mgr as any,
      })
      expect(res.url).toBe('http://0.0.0.0:38500')
    })
  })

  describe('regression coverage for the original split-brain bug', () => {
    it("never calls manager.start when VM isolation is on and the resolver succeeds", async () => {
      // This is the bug from the user's 1.6.x main.log: `agent-proxy`
      // and `resolveAgentRuntimeUrl` in server.ts called
      // `runtimeManager.start()` even with SHOGO_VM_ISOLATION=true,
      // producing a host runtime in parallel with the (eventually
      // booted) warm-pool VM. Through this helper, host mode is now
      // unreachable when VM resolution succeeds.
      const mgr = fakeRuntimeManager()
      const res = await resolveProjectPodUrl('proj-1', {
        _isKubernetes: () => false,
        _isVMIsolation: () => true,
        _vmResolver: async () => 'http://localhost:39200',
        runtimeManager: mgr as any,
      })
      expect(res.mode).toBe('vm')
      expect(mgr.start).toHaveBeenCalledTimes(0)
    })
  })
})

describe('defaultIsKubernetes and defaultIsVMIsolation (env probes)', () => {
  const origK8s = process.env.KUBERNETES_SERVICE_HOST
  const origVM  = process.env.SHOGO_VM_ISOLATION

  afterEach(() => {
    if (origK8s === undefined) delete process.env.KUBERNETES_SERVICE_HOST
    else process.env.KUBERNETES_SERVICE_HOST = origK8s
    if (origVM === undefined) delete process.env.SHOGO_VM_ISOLATION
    else process.env.SHOGO_VM_ISOLATION = origVM
  })

  test('routes to k8s when KUBERNETES_SERVICE_HOST is set (covers defaultIsKubernetes)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    delete process.env.SHOGO_VM_ISOLATION
    const res = await resolveProjectPodUrl('proj-env', {
      _k8sResolver: async () => 'http://knative-pod:8080',
    })
    expect(res.mode).toBe('k8s')
    expect(res.url).toBe('http://knative-pod:8080')
  })

  test('routes to vm when SHOGO_VM_ISOLATION=true and no k8s (covers defaultIsVMIsolation)', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.SHOGO_VM_ISOLATION = 'true'
    const res = await resolveProjectPodUrl('proj-env', {
      _vmResolver: async () => 'http://vm-pool:39000',
    })
    expect(res.mode).toBe('vm')
    expect(res.url).toBe('http://vm-pool:39000')
  })
})
