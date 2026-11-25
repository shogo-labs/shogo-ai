// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Idle-VM reclaim (SHO-534): hand an idle VM's RAM back to the host through the
 * balloon, without suspending it.
 *
 * Prod is 2 vCPU / 4 GiB guests on hosts where RAM is what limits density, and
 * ~96% of VM-hours are idle. The reaper already suspends what nobody uses, but
 * it cannot touch an always-on VM, and a VM in the relaxed window keeps its whole
 * footprint for hours. This is the pass that makes the idle tail cheap in between.
 *
 * Driven with a fake manager (no Firecracker host): what matters here is WHO is
 * picked — never a VM with a user, a turn, a stream or work in flight — and that
 * a request gives the RAM back without waiting on it.
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

const WINDOW = 5 * 60_000

class TestPool extends MetalWarmPool {
  seed(projectId: string, fields: Partial<AssignedVm> = {}) {
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

  deflateAll(): Promise<void> {
    for (const a of (this as any).assigned.values()) (this as any).deflateReclaimed(a, 'test')
    return Promise.resolve()
  }
}

/** Records every balloon call the pool makes, and answers like a stats-capable guest. */
function makeMgr(opts: { stats?: boolean; reclaimMiB?: number } = {}) {
  const reclaims: Array<{ vmId: string; floorMiB: number; maxWaitMs: number }> = []
  const deflates: string[] = []
  let inflight = 0
  let maxInflight = 0
  const mgr = {
    procCount: () => 0,
    isRunning: () => true,
    reclaimIdle: async (handle: any, o: { floorMiB: number; maxWaitMs: number }) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await Bun.sleep(1)
      inflight--
      reclaims.push({ vmId: handle.id, floorMiB: o.floorMiB, maxWaitMs: o.maxWaitMs })
      if (opts.stats === false) return { reclaimedMiB: 0, increasedMiB: 0, statsAvailable: false }
      const reclaimedMiB = opts.reclaimMiB ?? 2048
      return { reclaimedMiB, increasedMiB: reclaimedMiB, statsAvailable: true }
    },
    deflate: async (handle: any) => {
      deflates.push(handle.id)
    },
  }
  return {
    mgr: mgr as unknown as FirecrackerVMManager,
    reclaims,
    deflates,
    maxInflight: () => maxInflight,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metal-idle-reclaim-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makePool(mgr: FirecrackerVMManager, overrides: Partial<typeof config> = {}) {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleReclaim: true,
    idleReclaimMs: WINDOW,
    idleReclaimFloorMiB: 256,
    ...overrides,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  return new TestPool(mgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('reclaimIdleVms', () => {
  test('inflates an assigned VM idle past the window, leaving the floor', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('idle', { lastRealActivityAt: now - WINDOW - 1_000 })

    const done = await pool.reclaimIdleVms(now)

    expect(done).toEqual(['idle'])
    expect(reclaims).toEqual([{ vmId: 'vm-idle', floorMiB: 256, maxWaitMs: 0 }])
    expect(a.balloonedMiB).toBe(2048)
  })

  test('never inflates a VM a user, a turn or a stream is using', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const old = now - WINDOW - 1_000

    // app request inside the activity window → "app" liveness
    pool.seed('app-active', { lastRealActivityAt: old, lastAppRequestAt: now - 5_000 })
    // an agent turn in flight → "agent" liveness
    pool.seed('mid-turn', { lastRealActivityAt: old, lastAgentRequestAt: now - 1_000 })
    // a live stream, even with a stale clock
    pool.seed('streaming', { lastRealActivityAt: old, activeStreams: 1, lastAppRequestAt: now - 1_000 })
    // the guest says it is busy (a background task), clock long past
    pool.seed('busy', { lastRealActivityAt: old, busy: true, lastUserActivityAt: old })

    expect(await pool.reclaimIdleVms(now)).toEqual([])
    expect(reclaims).toEqual([])
  })

  test('leaves a VM inside the window alone', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    pool.seed('recent', { lastRealActivityAt: now - 60_000 })

    expect(await pool.reclaimIdleVms(now)).toEqual([])
    expect(reclaims).toEqual([])
  })

  test('always-on VMs are reclaimed too (they are never suspended)', async () => {
    const { mgr } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    // alwaysOn = true is what makes reapIdle skip it forever.
    const a = pool.seed('paid-always-on', {
      lastRealActivityAt: now - WINDOW - 1_000,
      alwaysOn: true,
    })

    expect(await pool.reclaimIdleVms(now)).toEqual(['paid-always-on'])
    expect(a.balloonedMiB).toBe(2048)
  })

  test('a VM with no balloon stats is skipped and marked, never blind-inflated', async () => {
    const { mgr, reclaims } = makeMgr({ stats: false })
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('no-stats', { lastRealActivityAt: now - WINDOW - 1_000 })

    expect(await pool.reclaimIdleVms(now)).toEqual([])
    expect(reclaims.length).toBe(1) // tried once…
    expect(a.balloonUnsupported).toBe(true)
    expect(a.balloonedMiB).toBeUndefined()

    // …and not again on the next pass: there is nothing to learn from a retry.
    await pool.reclaimIdleVms(now + 60_000)
    expect(reclaims.length).toBe(1)
  })

  test('contends with nothing: one pass is capped so a tick cannot stall', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    for (let i = 0; i < 20; i++) pool.seed(`p${i}`, { lastRealActivityAt: now - WINDOW - 1_000 })

    // The cap is per pass; the rest are picked up on later ticks.
    expect((await pool.reclaimIdleVms(now)).length).toBeLessThan(20)
    expect(reclaims.length).toBeLessThan(20)
  })

  test('a VM already holding reclaimed RAM is not inflated twice', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    pool.seed('already', { lastRealActivityAt: now - WINDOW - 1_000, balloonedMiB: 2048 })

    expect(await pool.reclaimIdleVms(now)).toEqual([])
    expect(reclaims).toEqual([])
  })

  test('does nothing at all with the flag off (byte-identical to today)', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr, { idleReclaim: false })
    const now = Date.now()
    pool.seed('idle', { lastRealActivityAt: now - 10 * WINDOW })

    expect(await pool.reclaimIdleVms(now)).toEqual([])
    expect(reclaims).toEqual([])
  })

  test('counts the reclaimed MiB and the VMs holding it as gauges', async () => {
    const { mgr } = makeMgr({ reclaimMiB: 3000 })
    const pool = makePool(mgr)
    const now = Date.now()
    const before = metrics.getCounter(M.balloonReclaimedMiB)
    pool.seed('a', { lastRealActivityAt: now - WINDOW - 1_000 })
    await pool.reclaimIdleVms(now)
    pool.status() // publishes the fleet gauges

    expect(metrics.getCounter(M.balloonReclaimedMiB) - before).toBe(3000)
    expect(metrics.getGauge(M.idleReclaimedVms)).toBe(1)
  })
})

describe('deflate on activity', () => {
  test('a proxied request hands the RAM back without waiting for it', async () => {
    const { mgr, deflates, maxInflight } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('idle', { lastRealActivityAt: now - WINDOW - 1_000 })
    await pool.reclaimIdleVms(now)
    expect(a.balloonedMiB).toBe(2048)

    // touch() is on the request path: it must return synchronously.
    pool.touch('idle')

    expect(a.balloonedMiB).toBeUndefined()
    expect(a.lastBalloonAt).toBeGreaterThan(0)
    await Bun.sleep(10)
    expect(deflates).toEqual(['vm-idle'])
    expect(maxInflight()).toBe(1) // no overlapping balloon ops from the pool
  })

  test('reclaim is not retried until another full idle window passes (hysteresis)', async () => {
    const { mgr, reclaims } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('idle', { lastRealActivityAt: now - WINDOW - 1_000 })
    await pool.reclaimIdleVms(now)
    pool.touch('idle')
    await Bun.sleep(5)

    // A request every few seconds must not make the balloon flap: the clock is
    // still long-idle, but the deflate just happened.
    expect(await pool.reclaimIdleVms(now + 1_000)).toEqual([])
    expect(reclaims.length).toBe(1)

    // After a full window it is eligible again.
    a.lastRealActivityAt = now + 1_000 - WINDOW - 1_000
    expect(await pool.reclaimIdleVms(now + WINDOW + 2_000)).toEqual(['idle'])
    expect(reclaims.length).toBe(2)
  })

  test('touch on a VM with nothing reclaimed does not call the manager', async () => {
    const { mgr, deflates } = makeMgr()
    const pool = makePool(mgr)
    pool.seed('fresh', { lastRealActivityAt: Date.now() })

    pool.touch('fresh')
    await Bun.sleep(5)

    expect(deflates).toEqual([])
  })

  /** Answer /pool/activity like a guest would, and nothing else. */
  async function pollWith(pool: TestPool, body: Record<string, unknown>) {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as any
    try {
      await pool.pollActivity()
    } finally {
      globalThis.fetch = realFetch
    }
    await Bun.sleep(5)
  }

  test('app activity seen by the poll (no request through the proxy) deflates it', async () => {
    const { mgr, deflates } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('idle', { lastRealActivityAt: now - WINDOW - 1_000 })
    await pool.reclaimIdleVms(now)
    expect(a.balloonedMiB).toBe(2048)

    await pollWith(pool, {
      lastRequestAt: Date.now(),
      lastAppRequestAt: Date.now(),
      lastAgentRequestAt: null,
      appRequestCount: 4,
      activeStreams: 0,
      busy: false,
    })

    expect(a.balloonedMiB).toBeUndefined()
    expect(deflates).toEqual(['vm-idle'])
  })

  test('a guest busy with work nobody asked for still gets its RAM back', async () => {
    const { mgr, deflates } = makeMgr()
    const pool = makePool(mgr)
    const now = Date.now()
    const a = pool.seed('idle', { lastRealActivityAt: now - WINDOW - 1_000 })
    await pool.reclaimIdleVms(now)

    // A background task or a scheduled run: liveness says idle (nobody is
    // using it) but the guest needs the memory it gave back.
    await pollWith(pool, {
      lastRequestAt: Date.now(),
      lastAppRequestAt: Date.now() - WINDOW - 1_000,
      lastAgentRequestAt: null,
      appRequestCount: 1,
      activeStreams: 0,
      busy: true,
      activeTurns: 1,
    })

    expect(a.balloonedMiB).toBeUndefined()
    expect(deflates).toEqual(['vm-idle'])
  })
})
