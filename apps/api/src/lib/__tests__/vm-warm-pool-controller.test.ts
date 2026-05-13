// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VMWarmPoolController Test Suite
 *
 * Tests the desktop VM warm pool controller — verifies that:
 * 1. Concurrent requests for the same project don't claim multiple VMs
 * 2. Only one VM gets assigned per project even under race conditions
 * 3. The pool reconciles correctly after claims
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import crypto from 'crypto'
import { VMWarmPoolController, type VMManagerInterface, type VMManagerFactory } from '../vm-warm-pool-controller'

// Tracks all VMs started/stopped by the mock manager
let vmCounter = 0
let startedVMs: string[] = []
let stoppedVMs: string[] = []
let assignCalls: { url: string; projectId: string }[] = []

function createMockVMManager(): VMManagerInterface {
  const handles = new Map<string, { running: boolean }>()

  return {
    async startVM(config: any) {
      const id = `vm-${++vmCounter}`
      const port = 10000 + vmCounter
      handles.set(id, { running: true })
      startedVMs.push(id)
      return {
        id,
        agentUrl: `http://localhost:${port}`,
        pid: 1000 + vmCounter,
        platform: 'darwin' as const,
      }
    },
    async stopVM(handle: any) {
      const h = handles.get(handle.id)
      if (h) h.running = false
      stoppedVMs.push(handle.id)
    },
    isRunning(handle: any) {
      return handles.get(handle.id)?.running ?? false
    },
    async forwardPort() {},
    async removeForward() {},
  }
}

// Mock fetch for /pool/assign and /health calls
const originalFetch = globalThis.fetch
function installMockFetch() {
  globalThis.fetch = mock((url: string, options?: any) => {
    if (typeof url === 'string' && url.includes('/pool/assign')) {
      let body: any = {}
      try { body = JSON.parse(options?.body || '{}') } catch {}
      assignCalls.push({ url, projectId: body.projectId })
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('OK'),
      })
    }
    if (typeof url === 'string' && url.includes('/health')) {
      return Promise.resolve({ ok: true })
    }
    return Promise.resolve({ ok: false, text: () => Promise.resolve('not found') })
  }) as any
}

// Mock buildProjectEnv since it touches Prisma
mock.module('../runtime/build-project-env', () => ({
  buildProjectEnv: mock(() => Promise.resolve({ PROJECT_ID: 'test' })),
}))

describe('VMWarmPoolController', () => {
  let pool: VMWarmPoolController

  beforeEach(() => {
    vmCounter = 0
    startedVMs = []
    stoppedVMs = []
    assignCalls = []
    installMockFetch()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (pool) await pool.stop()
  })

  test('concurrent getProjectUrl calls for same project claim only one VM', async () => {
    const factory: VMManagerFactory = () => createMockVMManager()
    pool = new VMWarmPoolController(factory, {}, 2)

    // Start pool — this boots 2 warm VMs
    await pool.start()
    const status = pool.getStatus()
    expect(status.available).toBe(2)

    // Fire 5 concurrent requests for the same project (simulating frontend
    // hitting sandbox/url, quick-actions, chat, wake, status all at once)
    const results = await Promise.all([
      pool.getProjectUrl('proj-1'),
      pool.getProjectUrl('proj-1'),
      pool.getProjectUrl('proj-1'),
      pool.getProjectUrl('proj-1'),
      pool.getProjectUrl('proj-1'),
    ])

    // All 5 requests should return the SAME URL (same VM)
    const uniqueUrls = new Set(results)
    expect(uniqueUrls.size).toBe(1)

    // Only one VM should have been assigned to proj-1
    const afterStatus = pool.getStatus()
    expect(afterStatus.assigned).toBe(1)

    // /pool/assign should have been called exactly once for this project
    const proj1Assigns = assignCalls.filter(c => c.projectId === 'proj-1')
    expect(proj1Assigns.length).toBe(1)
  })

  test('different projects get different VMs', async () => {
    const factory: VMManagerFactory = () => createMockVMManager()
    // Pin maxAssigned=3 so the cap doesn't LRU-evict the first project
    // when the host's reported free memory is low (the auto-compute used
    // to read totalmem so was effectively unbounded — now it reads
    // freemem clamped by VM_MAX_HARD_CAP).
    pool = new VMWarmPoolController(factory, {}, 3, 3)
    await pool.start()

    const [url1, url2] = await Promise.all([
      pool.getProjectUrl('proj-1'),
      pool.getProjectUrl('proj-2'),
    ])

    expect(url1).not.toBe(url2)

    const afterStatus = pool.getStatus()
    expect(afterStatus.assigned).toBe(2)
  })

  test('second call returns cached assignment within grace period', async () => {
    const factory: VMManagerFactory = () => createMockVMManager()
    pool = new VMWarmPoolController(factory, {}, 1)
    await pool.start()

    const url1 = await pool.getProjectUrl('proj-1')

    // Second call should return the same URL from the assigned cache
    // (fast path — no new claim or assign)
    assignCalls = []
    const url2 = await pool.getProjectUrl('proj-1')

    expect(url2).toBe(url1)
    expect(assignCalls.length).toBe(0)
  })

  test('pool does not exceed pool size after rapid claims', async () => {
    const factory: VMManagerFactory = () => createMockVMManager()
    pool = new VMWarmPoolController(factory, {}, 1, 1)
    await pool.start()
    expect(pool.getStatus().available).toBe(1)

    // Claim the one warm VM
    await pool.getProjectUrl('proj-1')

    // Let reconcile run
    await new Promise(r => setTimeout(r, 100))

    // Total VMs (assigned + available) should not exceed pool size + assigned
    const s = pool.getStatus()
    expect(s.assigned).toBe(1)
    // Available should be at most poolSize (1)
    expect(s.available).toBeLessThanOrEqual(1)
  })

  test('reconcile() is reentrant — concurrent calls boot exactly one batch', async () => {
    // Use a slow-boot manager so the reconcile race window is wide. Track
    // every startVM call across all manager instances.
    let startCount = 0
    const slowFactory: VMManagerFactory = () => ({
      async startVM() {
        startCount++
        await new Promise(r => setTimeout(r, 100))
        return {
          id: `vm-${startCount}`,
          agentUrl: `http://localhost:${10000 + startCount}`,
          pid: 1000 + startCount,
          platform: 'darwin' as const,
        }
      },
      async stopVM() {},
      isRunning: () => true,
      async forwardPort() {},
      async removeForward() {},
    })

    pool = new VMWarmPoolController(slowFactory, {}, 1, 1)
    await pool.start()

    // After start(), exactly 1 VM boots
    expect(startCount).toBe(1)

    // 5 concurrent reconciles on a full pool should boot 0 more VMs
    await Promise.all([
      (pool as any).reconcile(),
      (pool as any).reconcile(),
      (pool as any).reconcile(),
      (pool as any).reconcile(),
      (pool as any).reconcile(),
    ])
    expect(startCount).toBe(1)
  })

  test('getProjectUrl across distinct projects never exceeds maxAssigned', async () => {
    // Slow boot reproduces the race where multiple _assignProject callers
    // pass the cap check before any of them populate `assigned`.
    let liveVMs = 0
    let maxLive = 0
    const slowFactory: VMManagerFactory = () => ({
      async startVM() {
        liveVMs++
        maxLive = Math.max(maxLive, liveVMs)
        await new Promise(r => setTimeout(r, 100))
        return {
          id: crypto.randomUUID(),
          agentUrl: `http://localhost:${10000 + liveVMs}`,
          pid: 1000 + liveVMs,
          platform: 'darwin' as const,
        }
      },
      async stopVM() {
        liveVMs = Math.max(0, liveVMs - 1)
      },
      isRunning: () => true,
      async forwardPort() {},
      async removeForward() {},
    })

    const POOL_SIZE = 1
    const MAX = 2
    pool = new VMWarmPoolController(slowFactory, {}, POOL_SIZE, MAX)
    await pool.start()

    // 10 concurrent assigns for distinct projects. The cap is 2 plus the
    // 1 warm-pool slot. With the back-pressure logic, max live at any
    // point should be ≤ MAX + POOL_SIZE + 1 (the +1 covers the race
    // between claim() and the replacement warm-pool boot).
    let pollMaxAssigned = 0
    let polling = true
    ;(async () => {
      while (polling) {
        pollMaxAssigned = Math.max(pollMaxAssigned, pool.getStatus().assigned)
        await new Promise(r => setTimeout(r, 10))
      }
    })()

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => pool.getProjectUrl(`proj-${i}`)),
    )
    await new Promise(r => setTimeout(r, 200))
    polling = false

    expect(pollMaxAssigned).toBeLessThanOrEqual(MAX)
    expect(pool.getStatus().assigned).toBe(MAX)
    expect(maxLive).toBeLessThanOrEqual(MAX + POOL_SIZE + 1)
  })

  test('VM_MAX_HARD_CAP clamps the auto-computed cap', async () => {
    // Without an explicit maxAssignedOverride, the controller computes the
    // cap from free RAM clamped by VM_MAX_HARD_CAP. We can't reliably
    // manipulate freemem in a test, but we *can* assert the cap never
    // exceeds the hard ceiling regardless of host size.
    const factory: VMManagerFactory = () => createMockVMManager()
    pool = new VMWarmPoolController(factory, { memoryMB: 1024 }, 1)
    const cap = pool.getStatus().maxAssigned
    // MAX_VM_HARD_CAP defaults to 4; the test env may override it. The
    // invariant under test: cap is finite, >= 1, and never higher than
    // the hard ceiling (read from env at module load).
    const hardCap = parseInt(process.env.VM_MAX_HARD_CAP || '4', 10)
    expect(cap).toBeGreaterThanOrEqual(1)
    expect(cap).toBeLessThanOrEqual(hardCap)
  })
})
