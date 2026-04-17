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
    pool = new VMWarmPoolController(factory, {}, 3)
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
    pool = new VMWarmPoolController(factory, {}, 1)
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
})
