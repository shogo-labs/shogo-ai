// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — API health watchdog. The guest reports each project's API sidecar
 * state in `/pool/activity`; a runtime unhealthy past the threshold, with no
 * agent turn in flight, is recycled (observe-only by default), at most once an
 * hour and twice a day per runtime.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type ApiWatchdogMode } from './config'
import { M, metrics } from './metrics'
import { MetalWarmPool, type AssignedVm, type RecycleReport } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const HANDLE = { id: 'vm-1', agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any
const MIN = 60_000

class TestPool extends MetalWarmPool {
  recycles: Array<{ key: string; reason?: string }> = []
  abort = false

  override async recycle(key: string, opts: { reason?: string } = {}): Promise<RecycleReport> {
    this.recycles.push({ key, reason: opts.reason })
    if (!this.abort) (this as any).assigned.delete(key)
    return { runtimeKey: key, state: 'assigned', resumed: false, forced: false, aborted: this.abort, steps: [] }
  }

  add(projectId: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId,
      handle: HANDLE,
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

let dir: string
function makePool(mode: ApiWatchdogMode = 'enforce'): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    activityPoll: true,
    apiWatchdogMode: mode,
    apiUnhealthyRecycleMs: 10 * MIN,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return new TestPool({ procCount: () => 0 } as unknown as FirecrackerVMManager, cfg, {
    kind: 'none',
  } as unknown as SnapshotStore)
}

function guestReporting(previewHealth: unknown) {
  globalThis.fetch = mock(async () => Response.json({ lastRequestAt: 0, activeStreams: 0, previewHealth })) as any
}

describe('API health watchdog', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-watchdog-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('health tracking from /pool/activity', () => {
    test('a crashed sidecar starts the unhealthy clock; recovery clears it', async () => {
      const pool = makePool()
      const a = pool.add('ws:proj:p1')
      guestReporting([{ projectId: 'p1', apiPhase: 'crashed', apiReady: false }])
      await pool.pollActivity()
      expect(a.apiUnhealthySince).toBeNumber()
      expect(a.apiUnhealthyProjects).toEqual(['p1:crashed'])
      const since = a.apiUnhealthySince

      await pool.pollActivity()
      expect(a.apiUnhealthySince).toBe(since!)

      guestReporting([{ projectId: 'p1', apiPhase: 'healthy', apiReady: true }])
      await pool.pollActivity()
      expect(a.apiUnhealthySince).toBeUndefined()
    })

    test('a project with no sidecar, or an older guest, is not unhealthy', async () => {
      const pool = makePool()
      const a = pool.add('ws:proj:p1')
      guestReporting([{ projectId: 'p1', apiPhase: 'idle', apiReady: false }])
      await pool.pollActivity()
      expect(a.apiUnhealthySince).toBeUndefined()
      guestReporting(undefined)
      await pool.pollActivity()
      expect(a.apiUnhealthySince).toBeUndefined()
    })
  })

  test('recycles a runtime unhealthy past the threshold', async () => {
    const pool = makePool()
    pool.add('ws:proj:p1', { apiUnhealthySince: Date.now() - 11 * MIN, apiUnhealthyProjects: ['p1:crashed'] })
    pool.add('ws:proj:p2', { apiUnhealthySince: Date.now() - 2 * MIN })
    const ids = await pool.autoRecycleUnhealthy()
    expect(ids).toEqual(['ws:proj:p1'])
    expect(pool.recycles[0].reason).toMatch(/api unhealthy for 11m \(p1:crashed\)/)
    expect(metrics.getGauge(M.apiUnhealthy)).toBe(2)
  })

  test('never interrupts an agent turn in flight', async () => {
    const pool = makePool()
    pool.add('ws:proj:p1', { apiUnhealthySince: Date.now() - 30 * MIN, activeStreams: 1 })
    expect(await pool.autoRecycleUnhealthy()).toEqual([])
    expect(pool.recycles).toEqual([])
  })

  test('observe mode logs once per episode and recycles nothing', async () => {
    const pool = makePool('observe')
    const a = pool.add('ws:proj:p1', { apiUnhealthySince: Date.now() - 30 * MIN })
    const before = metrics.getCounter(M.autoRecycleObserved)
    await pool.autoRecycleUnhealthy()
    await pool.autoRecycleUnhealthy()
    expect(pool.recycles).toEqual([])
    expect(metrics.getCounter(M.autoRecycleObserved) - before).toBe(1)
    expect(a.apiWatchdogObserved).toBe(true)
  })

  test('off mode does nothing', async () => {
    const pool = makePool('off')
    pool.add('ws:proj:p1', { apiUnhealthySince: Date.now() - 30 * MIN })
    expect(await pool.autoRecycleUnhealthy()).toEqual([])
    expect(pool.recycles).toEqual([])
  })

  test('caps attempts at one per hour and two per day, counting aborted attempts', async () => {
    const pool = makePool()
    pool.abort = true
    pool.add('ws:proj:p1', { apiUnhealthySince: 0 })
    const t0 = 100 * 24 * 60 * MIN
    await pool.autoRecycleUnhealthy(t0)
    await pool.autoRecycleUnhealthy(t0 + 30 * MIN) // within the hour
    expect(pool.recycles).toHaveLength(1)
    await pool.autoRecycleUnhealthy(t0 + 61 * MIN) // second of the day
    expect(pool.recycles).toHaveLength(2)
    await pool.autoRecycleUnhealthy(t0 + 5 * 60 * MIN) // day cap reached
    expect(pool.recycles).toHaveLength(2)
    await pool.autoRecycleUnhealthy(t0 + 25 * 60 * MIN) // first attempt aged out
    expect(pool.recycles).toHaveLength(3)
  })
})
