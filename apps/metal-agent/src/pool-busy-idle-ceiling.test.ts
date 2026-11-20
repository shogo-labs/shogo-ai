// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-420 — the busy-idle ceiling.
 *
 * A guest that wrongly reports `busy: true` (or leaks `activeStreams > 0`) is
 * never idle-suspended, because every lifecycle gate goes through `vmBusy`. It
 * therefore never rotates onto a fixed image either: for a guest too old to send
 * `activeTurns`/`liveStreams`, `vmInTurn` falls back to `vmBusy`, so even the
 * 24h rollout deadline cannot move it. Prod US on 2026-11-18: 19 of 84 running
 * VMs, last agent request 47h–55 days ago, ~12% of capacity.
 *
 * The ceiling cannot read `lastRealActivityAt`: `pollActivity` stamps that on
 * every poll where the guest reports busy, so a stuck guest always looks freshly
 * active. It reads `lastUserActivityAt`, which only real user requests move.
 *
 * Driven with fakes and a stub `/pool/activity` — no real host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { M, metrics } from './metrics'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000
const CEILING_MS = 10 * IDLE_MS
const HOUR = 3_600_000

class TestPool extends MetalWarmPool {
  suspendedIds: string[] = []
  override async suspend(projectId: string): Promise<any> {
    this.suspendedIds.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }
  seed(projectId: string, fields: Partial<AssignedVm>) {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
      alwaysOn: false,
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
}

function makePool(dir: string, ceilingMs = CEILING_MS): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleSuspendMs: IDLE_MS,
    busyIdleCeilingMs: ceilingMs,
    activityPoll: true,
    activityTimeoutMs: 50,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

/** A guest that keeps insisting it is busy, with no user request since `lastAt`. */
function stuckBusyGuest(lastAt: number) {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          lastRequestAt: 1,
          activeStreams: 2,
          busy: true,
          activeTurns: 1,
          liveStreams: 2,
          lastAppRequestAt: lastAt,
          lastAgentRequestAt: lastAt,
        }),
        { status: 200 },
      ),
    )
}

describe('busy-idle ceiling', () => {
  let dir: string
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  let warnings: string[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-busy-idle-'))
    warnings = []
    console.warn = (...args: any[]) => {
      warnings.push(args.map(String).join(' '))
    }
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    console.warn = realWarn
    rmSync(dir, { recursive: true, force: true })
  })

  test('suspends a guest that keeps reporting busy with no user activity past the ceiling', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    const a = pool.seed('stuck', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })
    const before = metrics.getCounter(M.busyIdleCeilingSuspended)

    // The real poll: the guest is busy, so lastRealActivityAt is stamped now —
    // which is exactly why the ceiling cannot read that field.
    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()
    expect(a.busy).toBe(true)
    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(a.lastUserActivityAt).toBe(old)

    expect(await pool.reapIdle(IDLE_MS)).toEqual(['stuck'])
    expect(warnings.some((w) => w.includes('[pool] busy-idle ceiling: suspending stuck'))).toBe(true)
    expect(metrics.getCounter(M.busyIdleCeilingSuspended) - before).toBe(1)
  })

  test('keeps a busy guest whose last agent turn is inside the ceiling', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    const a = pool.seed('working', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })

    // A turn started two idle windows ago: busy AND recently used.
    const recent = Date.now() - 2 * IDLE_MS
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 1,
            activeStreams: 2,
            busy: true,
            activeTurns: 1,
            liveStreams: 2,
            lastAppRequestAt: old,
            lastAgentRequestAt: recent,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.lastUserActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('working')).toBeDefined()
  })

  test('METAL_BUSY_IDLE_CEILING_MS=0 turns the ceiling off', async () => {
    const pool = makePool(dir, 0)
    const old = Date.now() - 2 * CEILING_MS
    pool.seed('stuck', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })

    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('stuck')).toBeDefined()
  })

  test('an always-on busy guest is never suspended by the ceiling', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    pool.seed('paid', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
      alwaysOn: true,
    })

    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a legacy busy guest with no per-class fields is never suspended by the ceiling', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    const a = pool.seed('legacy', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
    })

    // No lastAppRequestAt/lastAgentRequestAt keys at all: an older runtime that
    // cannot classify. Its only signal is the catch-all, which our own export
    // sweeps move, so idle cannot be told from used.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 1, activeStreams: 2, busy: true }), { status: 200 }),
      )) as any
    await pool.pollActivity()

    expect(a.perClassActivity).toBeUndefined()
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a VM adopted after a restart is past the ceiling on the first reaper pass', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    // adopt() seeds lastUserActivityAt to `now` and flags the VM for a baseline
    // correction; the guest's own report is the truth, and it says nobody has
    // used this VM for 48h.
    const a = pool.seed('adopted', {
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
      needsUserActivityBaseline: true,
    })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 1,
            activeStreams: 2,
            busy: true,
            activeTurns: 1,
            liveStreams: 2,
            lastAppRequestAt: null,
            lastAgentRequestAt: now - 48 * HOUR,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    // Baselined from the guest's report, not given a fresh ceiling.
    expect(a.perClassActivity).toBe(true)
    expect(a.lastUserActivityAt).toBe(now - 48 * HOUR)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['adopted'])
  })

  test('a VM resumed from an old snapshot is NOT suspended on the first pass', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    // resume() builds a fresh AssignedVm with perClassActivity undefined and
    // seeds lastUserActivityAt to `now` — the resume IS the user action. The
    // snapshot's frozen timestamps are history, and the reaper polls then reaps
    // in the same tick, so correcting from them would suspend the VM the moment
    // it came back (QA round 1).
    const a = pool.seed('resumed', {
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
    })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 1,
            activeStreams: 2,
            busy: true,
            activeTurns: 1,
            liveStreams: 2,
            lastAppRequestAt: now - 48 * HOUR,
            lastAgentRequestAt: now - 48 * HOUR,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.perClassActivity).toBe(true)
    expect(a.lastUserActivityAt).toBe(now)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('resumed')).toBeDefined()
  })

  test('a fresh assign with no guest history keeps its full ceiling', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    const a = pool.seed('fresh', { assignedAt: now, lastTouchedAt: now, lastRealActivityAt: now, lastUserActivityAt: now })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 1,
            activeStreams: 0,
            busy: false,
            lastAppRequestAt: null,
            lastAgentRequestAt: null,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.perClassActivity).toBe(true)
    expect(a.lastUserActivityAt).toBe(now)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('metal_busy_idle_vms counts a busy guest idle past the window, not a recently used one', async () => {
    const old = Date.now() - 2 * CEILING_MS

    // Busy, but a person used it a moment ago: not a busy-idle VM.
    const usedPool = makePool(dir)
    usedPool.seed('used', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: Date.now(),
      perClassActivity: true,
      lastAppRequestAt: Date.now(),
      lastAgentRequestAt: Date.now(),
    })
    globalThis.fetch = stuckBusyGuest(old) as any
    await usedPool.pollActivity()
    await usedPool.reapIdle(IDLE_MS)
    expect(metrics.getGauge(M.busyIdleVms)).toBe(0)

    // Busy, idle past the idle window but still inside the ceiling: this is the
    // VM the reaper would have suspended if it did not report busy.
    const idlePool = makePool(dir)
    idlePool.seed('busy-idle', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: Date.now() - 2 * IDLE_MS,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })
    globalThis.fetch = stuckBusyGuest(old) as any
    await idlePool.pollActivity()
    await idlePool.reapIdle(IDLE_MS)
    expect(metrics.getGauge(M.busyIdleVms)).toBe(1)
  })

  test('/status and the admin listing expose userIdleMs and busyIdle', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    pool.seed('stuck', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })

    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()

    const status = pool.getProjectStatus('stuck')
    expect(status.busy).toBe(true)
    expect(status.busyIdle).toBe(true)
    expect(status.userIdleMs).toBeGreaterThanOrEqual(2 * CEILING_MS)

    const listed = pool.status().assigned.find((v) => v.projectId === 'stuck')!
    expect(listed.busy).toBe(true)
    expect(listed.busyIdle).toBe(true)
    expect(listed.userIdleMs).toBeGreaterThanOrEqual(2 * CEILING_MS)
  })

  test('does not freeze a turn that just started from a non-user path (project call, hook, webchat)', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    // No app request or /agent/chat for two ceilings, and idle at the last poll.
    const a = pool.seed('hooked', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })

    // A trigger hook starts a turn: busy now, but neither per-class clock moves.
    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()
    expect(a.busy).toBe(true)
    expect(a.busySince).toBeGreaterThan(old)
    expect(pool.getProjectStatus('hooked').busyIdle).toBe(false)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('hooked')).toBeDefined()
  })

  test('a poll that reports not-busy ends the streak, so the next busy turn starts a fresh one', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    const a = pool.seed('between-turns', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: Date.now(),
      lastUserActivityAt: old,
      busySince: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 1, activeStreams: 0, busy: false, activeTurns: 0, liveStreams: 0, lastAppRequestAt: old, lastAgentRequestAt: old }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()
    expect(a.busySince).toBeUndefined()

    globalThis.fetch = stuckBusyGuest(old) as any
    await pool.pollActivity()
    expect(a.busySince).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('an adopted busy guest inherits its streak from the baseline, not from the deploy', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    const a = pool.seed('adopted-busy', {
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      lastUserActivityAt: now,
      needsUserActivityBaseline: true,
    })
    globalThis.fetch = stuckBusyGuest(now - 48 * HOUR) as any
    await pool.pollActivity()
    expect(a.busySince).toBe(now - 48 * HOUR)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['adopted-busy'])
  })

  test('an idle, not-busy VM reaped late is not reported as a busy-idle ceiling suspend', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 2 * CEILING_MS
    pool.seed('plain-idle', {
      assignedAt: old,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      lastUserActivityAt: old,
      perClassActivity: true,
      lastAppRequestAt: old,
      lastAgentRequestAt: old,
    })
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 1, activeStreams: 0, busy: false, activeTurns: 0, liveStreams: 0, lastAppRequestAt: old, lastAgentRequestAt: old }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()
    const before = metrics.getCounter(M.busyIdleCeilingSuspended)

    expect(await pool.reapIdle(IDLE_MS)).toEqual(['plain-idle'])
    expect(metrics.getCounter(M.busyIdleCeilingSuspended) - before).toBe(0)
    expect(warnings.some((w) => w.includes('busy-idle ceiling'))).toBe(false)
  })
})
