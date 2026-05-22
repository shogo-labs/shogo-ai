// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Stub the env-builder so the chain to @shogo/model-catalog (which has no
// built dist on this branch) doesn't blow up at module load.
mock.module('../runtime/build-project-env', () => ({
  buildProjectEnv: async () => ({ FOO: 'bar' }),
}))

const vmctl = await import('../vm-warm-pool-controller')
const {
  VMPoolPermanentlyDisabledError,
  VMWarmPoolController,
  getVMWarmPoolController,
  initVMWarmPool,
  isVMIsolation,
  getVMProjectUrl,
  stopVMWarmPool,
  recycleVMWarmPool,
} = vmctl as any

// ─── shared mock VMManager ────────────────────────────────────────────

let vmCounter = 0
const stoppedVMs: string[] = []
let stopVMError: Error | null = null

function freshManager() {
  const handles = new Map<string, { running: boolean }>()
  return {
    async startVM(_cfg: any) {
      const id = `vm-${++vmCounter}`
      const port = 10000 + vmCounter
      handles.set(id, { running: true })
      return { id, agentUrl: `http://localhost:${port}`, pid: 1000 + vmCounter, platform: 'darwin' as const }
    },
    async stopVM(h: any) {
      if (stopVMError) throw stopVMError
      const handle = handles.get(h.id)
      if (handle) handle.running = false
      stoppedVMs.push(h.id)
    },
    isRunning(h: any) {
      return handles.get(h.id)?.running ?? false
    },
    async forwardPort() {},
    async removeForward() {},
  }
}

const realFetch = globalThis.fetch
beforeEach(() => {
  vmCounter = 0
  stoppedVMs.length = 0
  stopVMError = null
  globalThis.fetch = mock((url: any) => {
    if (typeof url === 'string' && url.includes('/pool/assign')) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('OK') }) as any
    }
    if (typeof url === 'string' && url.includes('/health')) {
      return Promise.resolve({ ok: true }) as any
    }
    return Promise.resolve({ ok: false }) as any
  }) as any
})

afterEach(async () => {
  globalThis.fetch = realFetch
  // Drain singleton if a test left one initialized.
  try {
    await stopVMWarmPool()
  } catch {}
})

// ═══════════════════════════════════════════════════════════════════════
// VMPoolPermanentlyDisabledError (L100-105 ctor body)
// ═══════════════════════════════════════════════════════════════════════

describe('VMPoolPermanentlyDisabledError', () => {
  test('constructor sets code, name, message, consecutiveFailures', () => {
    const err = new VMPoolPermanentlyDisabledError(7)
    expect(err.code).toBe('VM_POOL_PERMANENTLY_DISABLED')
    expect(err.name).toBe('VMPoolPermanentlyDisabledError')
    expect(err.consecutiveFailures).toBe(7)
    expect(err.message).toContain('disabled after 7 consecutive boot failures')
    expect(err instanceof Error).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Module-level singleton API (L784-827)
// ═══════════════════════════════════════════════════════════════════════

describe('module-level singleton functions', () => {
  test('isVMIsolation reads SHOGO_VM_ISOLATION', () => {
    const orig = process.env.SHOGO_VM_ISOLATION
    process.env.SHOGO_VM_ISOLATION = 'true'
    expect(isVMIsolation()).toBe(true)
    process.env.SHOGO_VM_ISOLATION = 'false'
    expect(isVMIsolation()).toBe(false)
    delete process.env.SHOGO_VM_ISOLATION
    expect(isVMIsolation()).toBe(false)
    if (orig !== undefined) process.env.SHOGO_VM_ISOLATION = orig
  })

  test('getVMWarmPoolController throws when not initialized', () => {
    expect(() => getVMWarmPoolController()).toThrow(/not initialized/)
  })

  test('initVMWarmPool constructs + starts; getVMProjectUrl returns assigned URL; recycle + stop drain', async () => {
    await initVMWarmPool(freshManager(), { poolSize: 1 })
    const ctrl = getVMWarmPoolController()
    expect(ctrl).toBeDefined()
    // Idempotent second init is a no-op.
    await initVMWarmPool(freshManager(), { poolSize: 1 })

    const url = await getVMProjectUrl('proj-a')
    expect(url).toMatch(/^http:\/\/localhost:/)

    await recycleVMWarmPool()
    // Confirm singleton is still attached after recycle.
    expect(() => getVMWarmPoolController()).not.toThrow()

    await stopVMWarmPool()
    expect(() => getVMWarmPoolController()).toThrow(/not initialized/)
  })

  test('stopVMWarmPool + recycleVMWarmPool tolerate "no singleton" state', async () => {
    await expect(stopVMWarmPool()).resolves.toBeUndefined()
    await expect(recycleVMWarmPool()).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Public class methods (touch, getAssignedPod, isPermanentlyDisabled,
//   evictProject)
// ═══════════════════════════════════════════════════════════════════════

describe('VMWarmPoolController public method coverage', () => {
  test('touch + getAssignedPod return the assigned pod and update lastTouchedAt', async () => {
    const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
    await c.start()
    await c.getProjectUrl('proj-touch')
    const before = c.getAssignedPod('proj-touch')
    expect(before).toBeDefined()
    const baselineTs = before!.lastTouchedAt
    await new Promise((r) => setTimeout(r, 2))
    c.touch('proj-touch')
    const after = c.getAssignedPod('proj-touch')
    expect(after!.lastTouchedAt).toBeGreaterThanOrEqual(baselineTs)
    // unknown projectId is a silent no-op.
    expect(() => c.touch('nope')).not.toThrow()
    expect(c.getAssignedPod('nope')).toBeUndefined()
    await c.stop()
  })

  test('isPermanentlyDisabled flips once consecutiveBootFailures hits the cap', async () => {
    const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
    expect(c.isPermanentlyDisabled()).toBe(false)
    ;(c as any).consecutiveBootFailures = 999
    expect(c.isPermanentlyDisabled()).toBe(true)
  })

  test('evictProject(unknown) is a no-op; evictProject(known) releases the VM', async () => {
    const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
    await c.start()
    await c.getProjectUrl('proj-evict')
    expect(c.getAssignedPod('proj-evict')).toBeDefined()

    expect(() => c.evictProject('does-not-exist')).not.toThrow()
    c.evictProject('proj-evict')
    expect(c.getAssignedPod('proj-evict')).toBeUndefined()
    await c.stop()
  })

  test('evictProject swallows stopVM rejection (L498 catch arm)', async () => {
    const origErr = console.error
    const errs: any[][] = []
    console.error = (...a: any[]) => { errs.push(a) }
    try {
      const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
      await c.start()
      await c.getProjectUrl('proj-boom')
      stopVMError = new Error('hypervisor lost contact')
      c.evictProject('proj-boom')
      // Let the rejected stopVM().catch arrow run.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(errs.some((a) => String(a[0]).includes('Error stopping evicted VM'))).toBe(true)
      stopVMError = null
      await c.stop()
    } finally {
      console.error = origErr
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// recyclePool (L725-755) — exercised both with available-only pods and
// with assigned pods.
// ═══════════════════════════════════════════════════════════════════════

describe('VMWarmPoolController.recyclePool', () => {
  test('stops all VMs across available + assigned and reconciles fresh ones', async () => {
    const c = new VMWarmPoolController(freshManager(), { poolSize: 2 })
    await c.start()
    await c.getProjectUrl('proj-r1')
    await c.getProjectUrl('proj-r2')

    const beforeStopped = stoppedVMs.length
    await c.recyclePool()
    expect(stoppedVMs.length).toBeGreaterThanOrEqual(beforeStopped + 1)

    const status = c.getStatus()
    // After recycle, all old assigned pods are released.
    expect(status.assigned).toBe(0)
    await c.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Defensive catch arms in reconcile-fire-and-forget paths (L221-223, L264-266)
// ═══════════════════════════════════════════════════════════════════════

describe('reconcile() rejection -> .catch arrows fire on the fire-and-forget paths', () => {
  test('initial start() and post-claim reconcile both swallow rejections (L221-223 + L264-266)', async () => {
    const origErr = console.error
    const errs: any[][] = []
    console.error = (...a: any[]) => { errs.push(a) }
    try {
      const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
      // Force _reconcileOnce to throw synchronously every time. The two
      // catch arrows in question both .catch the returned promise — they
      // must absorb the rejection without bringing the controller down.
      ;(c as any)._reconcileOnce = async () => {
        throw new Error('reconcile blew up')
      }
      await expect(c.start()).resolves.toBeUndefined()
      // Let the fire-and-forget initial reconcile rejection settle.
      await new Promise((r) => setImmediate(r))
      expect(errs.some((a) => String(a[0]).includes('Initial reconciliation failed'))).toBe(true)

      // Now seed an assignment then trigger post-claim reconcile.
      const pod: any = {
        id: 'pod-claim',
        vmId: 'vm-claim',
        url: 'http://localhost:12345',
        createdAt: Date.now(),
        ready: true,
        lastTouchedAt: Date.now(),
      }
      ;(c as any).available.set(pod.id, pod)
      // claim() pulls from available and fires reconcile().catch(...).
      const claimed = (c as any).claim()
      expect(claimed).toBeDefined()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      // Post-claim reconcile arrow runs and logs.
      expect(errs.some((a) => String(a[0]).includes('reconcile error') || String(a[0]).includes('reconcile blew up'))).toBe(true)
      await c.stop()
    } finally {
      console.error = origErr
    }
  })

  test('setInterval-scheduled reconcile arrow swallows rejection (L225-227)', async () => {
    const realSetInterval = globalThis.setInterval
    let capturedTimerCb: (() => void) | null = null
    ;(globalThis as any).setInterval = (cb: () => void, _ms: number) => {
      if (!capturedTimerCb) {
        capturedTimerCb = cb
        return 9999 as any
      }
      return (realSetInterval as any)(cb, _ms)
    }
    const origErr = console.error
    const errs: any[][] = []
    console.error = (...a: any[]) => { errs.push(a) }
    try {
      const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
      ;(c as any)._reconcileOnce = async () => {
        throw new Error('timer reconcile blew up')
      }
      await c.start()
      expect(typeof capturedTimerCb).toBe('function')
      capturedTimerCb!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(errs.some((a) => String(a[0]).includes('Reconciliation error'))).toBe(true)
      await c.stop()
    } finally {
      console.error = origErr
      globalThis.setInterval = realSetInterval
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// L607 .catch arrow on parallel bootVM during reconcile
// ═══════════════════════════════════════════════════════════════════════

describe('reconcile parallel boot .catch arm (L607)', () => {
  test('logs "Failed to boot VM" when bootVM rejects in the boot pool loop', async () => {
    const origErr = console.error
    const errs: any[][] = []
    console.error = (...a: any[]) => { errs.push(a) }
    try {
      const c = new VMWarmPoolController(freshManager(), { poolSize: 2 })
      // Override bootVM to reject — bypasses the internal try/catch and
      // propagates to the .catch arrow at L607.
      ;(c as any).bootVM = async () => {
        throw new Error('boot rejected for L607 catch')
      }
      // Drive a reconcile directly (bypass start() so we don't fight the
      // initial-reconcile catch).
      await (c as any)._reconcileOnce()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(errs.some((a) => String(a[0]).includes('Failed to boot VM'))).toBe(true)
      await c.stop()
    } finally {
      console.error = origErr
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// waitForBootSlot (L455-457): direct invocation since the natural call
// site requires a precisely-timed concurrent _assignProject race that
// is too brittle to drive deterministically from a unit test.
// ═══════════════════════════════════════════════════════════════════════

describe('waitForBootSlot direct', () => {
  test('resolves when notifyBootComplete() is invoked', async () => {
    const c = new VMWarmPoolController(freshManager(), { poolSize: 1 })
    let resolved = false
    const waiter = (c as any).waitForBootSlot().then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    ;(c as any).notifyBootComplete()
    await waiter
    expect(resolved).toBe(true)
  })
})
