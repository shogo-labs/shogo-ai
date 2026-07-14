// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool per-class liveness — decomposing the assigned (running) set by WHY each
 * VM is live: end-user app traffic vs an in-flight agent turn vs the idle tail.
 *
 * This is the fleet-observability split that lets a raw "N running" gauge be
 * read as "app-users + agent-turns + idle" instead of one opaque number. The
 * classification is pure bookkeeping over the assigned map (no reaper impact),
 * so it's driven entirely with seeded fakes — no real Firecracker host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'
import { metrics, M } from './metrics'

class TestPool extends MetalWarmPool {
  seed(projectId: string, fields: Partial<AssignedVm>) {
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: 0,
      lastTouchedAt: Date.now(),
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool per-class liveness classification', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-liveness-class-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('buckets assigned VMs into agent-active / app-active / idle-tail and they sum to assigned', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('agent-turn', { activeStreams: 1, lastAppRequestAt: now }) // agent wins over app
    pool.seed('live-app', { activeStreams: 0, lastAppRequestAt: now - 5_000 }) // recent app traffic
    pool.seed('idle-tab', { activeStreams: 0, lastAppRequestAt: now - 10 * 60_000 }) // stale app → tail
    pool.seed('never-used', {}) // no app traffic ever → tail

    const s = pool.status()

    expect(s.liveness).toEqual({ agentActive: 1, appActive: 1, idleTail: 2 })
    expect(s.liveness.agentActive + s.liveness.appActive + s.liveness.idleTail).toBe(s.assigned.length)
  })

  test('status() exposes per-class idle ages on each assigned entry', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('p1', { lastAppRequestAt: now - 3_000, appRequestCount: 7, activeStreams: 2 })

    const entry = pool.status().assigned.find((a) => a.projectId === 'p1')!

    expect(entry.activeStreams).toBe(2)
    expect(entry.appRequestCount).toBe(7)
    expect(entry.appIdleMs).toBeGreaterThanOrEqual(3_000)
    // No agent-chat request recorded → null, not 0.
    expect(entry.agentIdleMs).toBeNull()
  })

  test('publishes fleet gauges for the assigned decomposition', () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('a', { activeStreams: 1 })
    pool.seed('b', { lastAppRequestAt: now })

    pool.status() // triggers publishGauges()

    expect(metrics.getGauge(M.assignedCount)).toBe(2)
    expect(metrics.getGauge(M.assignedAgentActive)).toBe(1)
    expect(metrics.getGauge(M.assignedAppActive)).toBe(1)
    expect(metrics.getGauge(M.assignedIdleTail)).toBe(0)
  })
})
