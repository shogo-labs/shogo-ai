// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HostWarmPoolController — dead-runtime detection.
 *
 * Regression for the Windows 1.14.1 measurement where a runtime killed a few
 * seconds after `/pool/assign` was still returned "optimistically" by
 * `getProjectUrl()` for the rest of the 60s startup grace: `sandbox/url`
 * reported `ready: true` while every agent-proxy call failed (~58s stall).
 *
 * The controller now (a) evicts on the ChildProcess `exit` event and (b)
 * checks `exitCode`/`signalCode` before honouring the grace window.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { EventEmitter } from 'events'

process.env.HOST_WARM_POOL_SIZE = process.env.HOST_WARM_POOL_SIZE || '1'

// The controller only needs these at assign/prepare time, which these tests
// never reach. Mock them so the import does not drag in prisma, the model
// catalog, and the RuntimeManager singleton.
mock.module('../runtime/build-project-env', () => ({
  buildProjectEnv: mock(async () => ({})),
}))
mock.module('../runtime', () => ({
  getRuntimeManager: () => ({
    prepareWarmWorkspace: async () => {},
    prepareProjectWorkspace: async (id: string) => `/tmp/${id}`,
  }),
}))

const { HostWarmPoolController, computeMaxAssignedFor } = await import('../host-warm-pool-controller')

class FakeProc extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  pid = 4242
  die(code: number | null = 1, signal: string | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function pod(id: string, port: number, assigned = false) {
  return {
    id,
    url: `http://localhost:${port}`,
    agentPort: port,
    pid: 4242,
    createdAt: Date.now(),
    ready: true,
    ...(assigned ? { assignedAt: Date.now(), lastTouchedAt: Date.now() } : {}),
  }
}

/** Wire a fake process into the controller exactly like `bootPod` does. */
function attach(controller: any, id: string): FakeProc {
  const proc = new FakeProc()
  controller.procs.set(id, proc)
  proc.on('exit', (code: number | null, signal: string | null) => controller.onRuntimeExit(id, code, signal))
  return proc
}

let controller: any
let destroyed: string[]

beforeEach(() => {
  controller = new HostWarmPoolController(1, 4)
  destroyed = []
  // Never shell out to taskkill/kill in tests; record what would be torn down.
  controller.killProcessGroup = (proc: any) => { destroyed.push(String(proc?.pid)) }
  controller.reconcile = mock(async () => {})
})

afterEach(() => {
  controller.started = false
})

describe('computeMaxAssignedFor', () => {
  test('a 64 GB workstation with the 8 GB ceiling is no longer capped at 2', () => {
    // 1.14.1 measured: freeMB≈35000, memCeil=8192 → floor(35000 / 16384) = 2.
    expect(computeMaxAssignedFor(35_000, 8192)).toBe(8) // hard cap
  })

  test('half of free RAM divided by the expected footprint', () => {
    expect(computeMaxAssignedFor(12_000, 8192)).toBe(3) // 6000 / 1536
    expect(computeMaxAssignedFor(6_000, 6553)).toBe(1)  // 3000 / 1536 → 1
  })

  test('never below 1, uses the ceiling only when it is smaller than the footprint', () => {
    expect(computeMaxAssignedFor(0, 8192)).toBe(1)
    expect(computeMaxAssignedFor(2_048, 512)).toBe(2)   // 1024 / 512
    expect(computeMaxAssignedFor(2_048, null)).toBe(1)
  })
})

describe('HostWarmPoolController dead-runtime handling', () => {
  test('exit of an assigned runtime evicts the project immediately', () => {
    const p = pod('host-a', 38300, true)
    controller.assigned.set('proj-1', p)
    const proc = attach(controller, 'host-a')

    proc.die(1)

    expect(controller.assigned.has('proj-1')).toBe(false)
    expect(controller.procs.has('host-a')).toBe(false)
    expect(controller.getAssignedPod('proj-1')).toBeUndefined()
  })

  test('exit of an idle pool runtime removes it and triggers a refill', () => {
    const p = pod('host-b', 38316)
    controller.available.set('host-b', p)
    controller.started = true
    const proc = attach(controller, 'host-b')

    proc.die(null, 'SIGKILL')

    expect(controller.available.has('host-b')).toBe(false)
    expect(controller.reconcile).toHaveBeenCalledTimes(1)
  })

  test('exits caused by our own destroyPod are ignored (no double-evict, no refill)', () => {
    const p = pod('host-c', 38332, true)
    controller.assigned.set('proj-2', p)
    controller.started = true
    const proc = attach(controller, 'host-c')

    // Controller-initiated teardown: destroyPod removes the proc record first.
    controller.evict('proj-2')
    expect(controller.procs.has('host-c')).toBe(false)
    controller.reconcile.mockClear()

    proc.die(null, 'SIGTERM')

    expect(controller.reconcile).not.toHaveBeenCalled()
    expect(controller.assigned.size).toBe(0)
  })

  test('getProjectUrl re-assigns a dead runtime even inside the startup grace window', async () => {
    const p = pod('host-d', 38348, true)
    p.assignedAt = Date.now() - 2_000 // well within STARTUP_GRACE_MS
    controller.assigned.set('proj-3', p)
    const proc = attach(controller, 'host-d')
    // Simulate death observed via exitCode without the event having run
    // (e.g. the exit callback is still queued behind the current request).
    proc.exitCode = 137

    let assignedCalls = 0
    controller._assignProject = async (projectId: string) => {
      assignedCalls++
      const fresh = pod('host-e', 38364, true)
      controller.assigned.set(projectId, fresh)
      return fresh.url
    }

    const url = await controller.getProjectUrl('proj-3', 'open-1')

    expect(assignedCalls).toBe(1)
    expect(url).toBe('http://localhost:38364')
    expect(controller.getAssignedPod('proj-3')?.id).toBe('host-e')
  })

  test('getProjectUrl keeps returning a live runtime inside the grace window without probing success', async () => {
    const p = pod('host-f', 38380, true)
    p.assignedAt = Date.now() - 2_000
    controller.assigned.set('proj-4', p)
    attach(controller, 'host-f') // alive: exitCode/signalCode remain null

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as any
    try {
      controller._assignProject = async () => { throw new Error('should not re-assign a live runtime') }
      const url = await controller.getProjectUrl('proj-4')
      expect(url).toBe('http://localhost:38380')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
