// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool idle-suspend gating — reapIdle must measure what a USER did, not what our
 * own machinery did.
 *
 * Two rounds of the same bug, both fixed here:
 *
 *  1. `lastTouchedAt` answers "did anything ask about this VM": a control-plane
 *     routing/status poll bumps it, and so does the activity poll every time it
 *     fails open. Both run on the reaper's own interval, so gating on it means a
 *     VM's idle age can never grow past one poll cycle and NO window ever
 *     expires. Production ran a 4h window and held ~320 VMs resident whose apps
 *     had been idle for days; only 3 fleet-wide ever qualified to suspend.
 *
 *  2. The guest's catch-all `lastRequestAt` counts every request it serves —
 *     including the host's writable-state and published-data export sweeps,
 *     which call `/pool/export-data` on EVERY assigned VM every 120s. Gating on
 *     that held 202 VMs resident, 67 of them sharing `realIdleMs` to the
 *     millisecond (one sweep stamped them all) while 93 had never served a
 *     single app or agent request in their lives.
 *
 * So the gate is the guest's own per-class user signals: `lastAppRequestAt`,
 * `lastAgentRequestAt`, `activeStreams`. Driven with fakes — no real host.
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

class TestPool extends MetalWarmPool {
  suspended: string[] = []
  /** When set, every idle suspend comes back `refused` (a non-durable HEAD). */
  refuseSuspend = false
  override async suspendOrRetire(projectId: string, opts: any = {}): Promise<any> {
    if (this.refuseSuspend) return { kind: 'refused', reason: 'its current HEAD is not in the durable repo (test)' }
    return super.suspendOrRetire(projectId, opts)
  }
  override async suspend(projectId: string): Promise<any> {
    this.suspended.push(projectId)
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

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleSuspendMs: IDLE_MS,
    activityPoll: true,
    activityTimeoutMs: 50,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('reapIdle gates on real guest activity, not lastTouchedAt', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idle-real-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('suspends a VM a routing poll keeps touching but whose guest is quiet', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    // The exact production shape: control plane polled it a moment ago, the
    // guest itself has served nothing for ages.
    pool.seed('polled-but-quiet', { lastTouchedAt: Date.now(), lastRealActivityAt: old, assignedAt: old })

    expect(await pool.reapIdle(IDLE_MS)).toEqual(['polled-but-quiet'])
  })

  test('keeps a VM whose guest served real traffic, even if nothing touched it', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    pool.seed('serving', { lastTouchedAt: old, lastRealActivityAt: Date.now(), assignedAt: old })

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('serving')).toBeDefined()
  })

  test('gives a freshly-placed VM a full window before its first request', async () => {
    const pool = makePool(dir)
    // Never reported activity: lastRealActivityAt falls back to assignedAt, so
    // the window runs from placement rather than suspending on the next tick.
    pool.seed('just-opened', { assignedAt: Date.now(), lastRealActivityAt: undefined })
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])

    pool.seed('opened-long-ago', { assignedAt: Date.now() - 10 * IDLE_MS, lastRealActivityAt: undefined })
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['opened-long-ago'])
  })

  test('a failed activity poll no longer extends the idle window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('unreachable-guest', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as any
    await pool.pollActivity()

    // Fail-open still marks it touched (other consumers rely on that)...
    expect(a.lastTouchedAt).toBeGreaterThan(old)
    // ...but it must not look like the guest did something.
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['unreachable-guest'])
  })

  test('an active stream counts as real activity and blocks suspension', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('generating', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ activeStreams: 1 }), { status: 200 }))) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a legacy guest with no per-class fields still keeps its window on traffic', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('busy', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.lastActivityAt = 1

    // No lastAppRequestAt/lastAgentRequestAt keys at all: an older runtime image
    // that cannot classify. The catch-all is then the only signal we have, so it
    // must still protect the VM rather than let us suspend real users.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 999, activeStreams: 0 }), { status: 200 }),
      )) as any
    await pool.pollActivity()

    expect(a.perClassActivity).toBeUndefined()
    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('the host export sweep advancing lastRequestAt does NOT hold a VM open', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('export-swept', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.lastActivityAt = 1

    // Exactly what production reported: the catch-all counter keeps climbing
    // because /pool/export-data is hit every 120s, while the guest states plainly
    // that no app request and no agent turn has EVER happened.
    let served = 1000
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: (served += 1000),
            activeStreams: 0,
            lastAppRequestAt: null,
            appRequestCount: 0,
            lastAgentRequestAt: null,
          }),
          { status: 200 },
        ),
      )) as any

    await pool.pollActivity()
    await pool.pollActivity()

    expect(a.perClassActivity).toBe(true)
    // Touched (something did reach the guest) but not "used".
    expect(a.lastTouchedAt).toBeGreaterThan(old)
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['export-swept'])
  })

  test('a real app request refreshes the window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('app-users', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.perClassActivity = true // already baselined by an earlier poll
    a.lastAppRequestAt = 5000

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 9000, activeStreams: 0, lastAppRequestAt: 6000, lastAgentRequestAt: null }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a real agent turn refreshes the window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('agent-chat', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.perClassActivity = true
    a.lastAgentRequestAt = 5000

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 9000, activeStreams: 0, lastAppRequestAt: null, lastAgentRequestAt: 7000 }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('the first poll after a restart treats an old timestamp as history, not activity', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    // adopt() seeds lastRealActivityAt, but this VM's last real use was days ago.
    const a = pool.seed('adopted', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 9000,
            activeStreams: 0,
            lastAppRequestAt: Date.now() - 2 * 24 * 3600 * 1000,
            lastAgentRequestAt: null,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    // Baseline recorded, window NOT refreshed — otherwise every agent restart
    // would grant the whole fleet a fresh window.
    expect(a.perClassActivity).toBe(true)
    expect(a.lastAppRequestAt).toBeGreaterThan(0)
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['adopted'])
  })

  test('expires frozen activeStreams after a sustained activity-poll failure', async () => {
    const pool = makePool(dir)
    const a = pool.seed('mute', { activeStreams: 5 })
    globalThis.fetch = (() => Promise.reject(new Error('timeout'))) as any
    a.activityPollFailedAt = Date.now() - 4 * 60_000
    await pool.pollActivity()
    expect(a.activeStreams).toBe(0)
    expect(a.lastHealthOk).toBe(false)
  })

  test('isBusy is false for a mute guest with a long-failed poll and stale agent turn', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * 60_000
    pool.seed('mute', {
      activeStreams: 3,
      lastAgentRequestAt: old,
      assignedAt: old,
      activityPollFailedAt: Date.now() - 4 * 60_000,
    })
    globalThis.fetch = (() => Promise.reject(new Error('timeout'))) as any
    expect(await pool.isBusy('mute')).toBe(false)
  })
})

describe('reapIdle under the two-tier window', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idle-tier-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a relaxed window keeps VMs the aggressive one would suspend', async () => {
    const pool = makePool(dir)
    const RELAXED = 100 * IDLE_MS
    pool.seed('idle-for-a-while', { lastRealActivityAt: Date.now() - 10 * IDLE_MS })

    expect(await pool.reapIdle(RELAXED, { tier: 'relaxed' })).toEqual([])
    expect(await pool.reapIdle(IDLE_MS, { tier: 'aggressive' })).toEqual(['idle-for-a-while'])
  })

  test('suspends longest-idle first and caps a pass', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('idle-5', { lastRealActivityAt: now - 5 * IDLE_MS })
    pool.seed('idle-50', { lastRealActivityAt: now - 50 * IDLE_MS })
    pool.seed('idle-20', { lastRealActivityAt: now - 20 * IDLE_MS })
    pool.seed('active', { lastRealActivityAt: now })

    expect(await pool.reapIdle(IDLE_MS, { maxPerPass: 2 })).toEqual(['idle-50', 'idle-20'])
    expect(await pool.reapIdle(IDLE_MS, { maxPerPass: 2 })).toEqual(['idle-5'])
    expect(pool.peek('active')).toBeDefined()
  })

  test('a mid-stream VM does not take a slot from the cap', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    pool.seed('streaming', { lastRealActivityAt: now - 100 * IDLE_MS, activeStreams: 1 })
    pool.seed('quiet', { lastRealActivityAt: now - 10 * IDLE_MS })

    expect(await pool.reapIdle(IDLE_MS, { maxPerPass: 1 })).toEqual(['quiet'])
  })
})

/**
 * SHO-348: `activeStreams` is a counter the guest can leak — a turn that was
 * stopped or frozen keeps it at 1 with nothing running behind it. The guest now
 * reports its own `busy`, and every lifecycle gate trusts that instead, so a
 * leaked counter can no longer keep a VM resident (and its expired AI-proxy
 * token unrefreshed) forever.
 */
describe('reapIdle gates on the guest\'s own busy verdict, not a leaked stream counter', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-busy-verdict-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('a guest that reports busy:false with activeStreams:1 is suspended', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('wedged', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 1, activeStreams: 1, busy: false, lastAppRequestAt: null, lastAgentRequestAt: null }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.busy).toBe(false)
    expect(a.activeStreams).toBe(1)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['wedged'])
  })

  test('a guest that reports busy:true is kept even with no streams counted', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    pool.seed('really-busy', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 1, activeStreams: 0, busy: true }), { status: 200 }),
      )) as any
    await pool.pollActivity()

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('isBusy follows the guest\'s busy verdict', async () => {
    const pool = makePool(dir)
    pool.seed('wedged', { assignedAt: Date.now() })

    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ activeStreams: 1, busy: false }), { status: 200 }))) as any
    expect(await pool.isBusy('wedged')).toBe(false)

    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ activeStreams: 0, busy: true }), { status: 200 }))) as any
    expect(await pool.isBusy('wedged')).toBe(true)
  })

  test('an older guest with no busy field still uses activeStreams', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('legacy', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ lastRequestAt: 1, activeStreams: 1 }), { status: 200 }))) as any
    await pool.pollActivity()

    expect(a.busy).toBeUndefined()
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })
})

/**
 * SHO-533 — the second half of the same bug: what "activity" means.
 *
 * `pollActivity` used to stamp `lastRealActivityAt` on every poll where the
 * guest reported `busy`, and `busy` counts heartbeat runs and background tasks.
 * Recipes tick every 10-60 min, so a project with a heartbeat reset its idle
 * clock on every poll and never reached even the aggressive window, let alone
 * the relaxed one: prod held 74 idle stretches of 13-24h and 23 of >24h
 * (2,195 VM-hours) while the meter billed every one of those hours as idle.
 *
 * Now one classifier (`vmLiveness`) decides: a streamed turn or a real app/agent
 * request is activity; being busy is not. `vmBusy` still blocks the suspend, so
 * a VM is never snapshotted mid-turn — it just goes at the first quiet poll.
 */
describe('SHO-533 — a busy guest no longer extends the idle window', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idle-busy-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  /** The guest's own report; `extra` is what one poll looks like. */
  const guest = (extra: Record<string, unknown>) => (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          lastRequestAt: 1,
          activeStreams: 0,
          busy: false,
          activeTurns: 0,
          liveStreams: 0,
          lastAppRequestAt: null,
          lastAgentRequestAt: null,
          ...extra,
        }),
        { status: 200 },
      ),
    )) as any

  test('a heartbeat-only project is suspended once the window has passed', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('heartbeat-only', {
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
      perClassActivity: true,
    })

    // Exactly the production shape: a heartbeat run takes a turn lock but opens
    // no stream, so the guest is busy with 0 live streams and no app/agent
    // request has EVER arrived.
    globalThis.fetch = guest({ busy: true, activeTurns: 1 })
    await pool.pollActivity()
    // The clock must not move — this is the assertion that fails on main, where
    // the busy poll stamped it to `now` and the window started over.
    expect(a.lastRealActivityAt).toBe(old)

    // Busy still wins: never snapshot a VM mid-turn. One reaper pass later, in
    // the gap between two heartbeat ticks, it goes.
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    globalThis.fetch = guest({ busy: false })
    await pool.pollActivity()
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['heartbeat-only'])
  })

  test('a background task is not activity either', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('background-task', {
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
      perClassActivity: true,
    })
    // A long `exec` or a `service: true` supervisor: busy, no turn, no stream.
    globalThis.fetch = guest({ busy: true, activeTurns: 0 })
    await pool.pollActivity()
    expect(a.lastRealActivityAt).toBe(old)
    expect(a.busy).toBe(true)
  })

  test('a live streamed turn is activity and resets the clock', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('streaming', {
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
      perClassActivity: true,
    })
    globalThis.fetch = guest({ busy: true, activeTurns: 1, activeStreams: 1, liveStreams: 1 })
    await pool.pollActivity()
    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('an automated wake gets the aggressive window, not the relaxed one', async () => {
    const pool = makePool(dir)
    const RELAXED = 100 * IDLE_MS
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('scheduled-wake', {
      lastRealActivityAt: old,
      assignedAt: old,
      // Assigned by a schedule tick: nobody has opened it.
      userSeenSinceAssign: false,
    })

    // Under the relaxed directive the window is 100x IDLE_MS, yet 10 is enough:
    // an automated wake must not buy hours of resident RAM nobody asked for.
    expect(await pool.reapIdle(RELAXED, { tier: 'relaxed' })).toEqual(['scheduled-wake'])
    expect(a.lastRealActivityAt).toBe(old)
  })

  test('a person showing up later restores the relaxed window', async () => {
    const pool = makePool(dir)
    const RELAXED = 100 * IDLE_MS
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('woken-then-opened', {
      lastRealActivityAt: old,
      assignedAt: old,
      userSeenSinceAssign: false,
      perClassActivity: true,
      lastAppRequestAt: 5000,
    })

    globalThis.fetch = guest({ lastAppRequestAt: 6000 })
    await pool.pollActivity()
    expect(a.userSeenSinceAssign).toBe(true)

    // Same 10 IDLE_MS of real idleness: now only the aggressive window suspends
    // it, and the relaxed directive leaves it alone.
    a.lastRealActivityAt = old
    expect(await pool.reapIdle(RELAXED, { tier: 'relaxed' })).toEqual([])
    expect(await pool.reapIdle(IDLE_MS, { tier: 'aggressive' })).toEqual(['woken-then-opened'])
  })
})

describe('SHO-533 — refusals are counted, backed off and visible', () => {
  let dir: string
  const realWarn = console.warn
  let warnings: string[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idle-refused-'))
    warnings = []
    console.warn = (...args: any[]) => {
      warnings.push(args.map(String).join(' '))
    }
  })
  afterEach(() => {
    console.warn = realWarn
    rmSync(dir, { recursive: true, force: true })
  })

  test('a refused VM backs off instead of costing a full export every pass', async () => {
    const pool = makePool(dir)
    pool.refuseSuspend = true
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('undurable-head', { lastRealActivityAt: old, assignedAt: old })

    const before = metrics.getCounter(M.idleSuspendRefused)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(a.refuseCount).toBe(1)
    expect(a.refusedSince).toBeGreaterThanOrEqual(old)
    expect(a.refuseRetryAt!).toBeGreaterThan(Date.now())
    expect(metrics.getCounter(M.idleSuspendRefused) - before).toBe(1)
    // Warned once, with the reason — not once per scan.
    expect(warnings.filter((w) => w.includes('idle-suspend is HELD')).length).toBe(1)

    // Still refused, but inside the backoff: no second attempt, no second export.
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(a.refuseCount).toBe(1)
    expect(metrics.getCounter(M.idleSuspendRefused) - before).toBe(1)
    expect(warnings.filter((w) => w.includes('idle-suspend is HELD')).length).toBe(1)
  })

  test('VMs waiting out a backoff do not consume the per-pass cap', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    const old = now - 20 * IDLE_MS
    // Two VMs whose HEAD cannot be made durable, both idle longest, so both sort
    // ahead of everything else in every pass.
    pool.seed('undurable-a', { lastRealActivityAt: old, assignedAt: old })
    pool.seed('undurable-b', { lastRealActivityAt: old, assignedAt: old })
    pool.refuseSuspend = true
    await pool.reapIdle(IDLE_MS)
    expect(pool.peek('undurable-a')!.refuseRetryAt).toBeDefined()
    expect(pool.peek('undurable-b')!.refuseRetryAt).toBeDefined()

    // A healthy idle VM that sorts LAST. With one slot per pass and the backoff
    // filtered after the cap, the two refused VMs would take it, be skipped, and
    // the reaper would suspend nothing — forever. Filtered before the cap, the
    // slot goes to the VM that can actually be suspended (QA round 1).
    pool.refuseSuspend = false
    pool.seed('healthy', { lastRealActivityAt: old + IDLE_MS, assignedAt: old + IDLE_MS })
    const backingOff = metrics.getCounter(M.idleReapRefusedBackoff)
    expect(await pool.reapIdle(IDLE_MS, { maxPerPass: 1 })).toEqual(['healthy'])
    expect(metrics.getCounter(M.idleReapRefusedBackoff) - backingOff).toBe(2)
    expect(pool.peek('undurable-a')).toBeDefined()
    expect(pool.peek('undurable-b')).toBeDefined()
  })

  test('the streak backs the retry off further each time, and a suspend clears it', async () => {
    const pool = makePool(dir)
    pool.refuseSuspend = true
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('undurable-head', { lastRealActivityAt: old, assignedAt: old })
    await pool.reapIdle(IDLE_MS)
    const firstRetry = a.refuseRetryAt! - Date.now()
    a.refuseRetryAt = Date.now() - 1 // pretend the backoff elapsed
    await pool.reapIdle(IDLE_MS)
    expect(a.refuseCount).toBe(2)
    expect(a.refuseRetryAt! - Date.now()).toBeGreaterThan(firstRetry)

    // The export finally lands: the next attempt suspends it and the streak goes.
    pool.refuseSuspend = false
    a.refuseRetryAt = Date.now() - 1
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['undurable-head'])
    expect(a.refuseCount).toBeUndefined()
    expect(a.refuseRetryAt).toBeUndefined()
  })

  test('status() says why each VM is held, and counts it per reason', async () => {
    const pool = makePool(dir)
    const now = Date.now()
    const old = now - 10 * IDLE_MS
    pool.seed('fresh', { lastRealActivityAt: now, assignedAt: now })
    pool.seed('settled', { lastRealActivityAt: now, assignedAt: now, perClassActivity: true })
    pool.seed('legacy-guest', { lastRealActivityAt: now, assignedAt: now })
    pool.seed('paid', { lastRealActivityAt: now, assignedAt: now, alwaysOn: true })

    // One refused VM, on its own: the reaper only attempts what is past the
    // window, so the others are aged after this pass.
    pool.refuseSuspend = true
    pool.seed('undurable', { lastRealActivityAt: old, assignedAt: old })
    await pool.reapIdle(IDLE_MS)
    expect(pool.peek('undurable')!.refuseCount).toBe(1)

    for (const id of ['settled', 'legacy-guest']) pool.peek(id)!.lastRealActivityAt = old
    const mid = pool.seed('mid-turn', { lastRealActivityAt: old, assignedAt: old, busy: true })

    const status = pool.status()
    const held = Object.fromEntries(status.assigned.map((v) => [v.projectId, v.holdReason]))
    expect(held).toMatchObject({
      fresh: 'window',
      settled: 'evictable',
      'legacy-guest': 'legacy',
      'mid-turn': 'busy',
      paid: 'alwaysOn',
      undurable: 'refused',
    })
    expect(mid.busy).toBe(true)
    expect(status.holdReasons).toMatchObject({ window: 1, evictable: 1, legacy: 1, busy: 1, alwaysOn: 1, refused: 1 })
    expect(status.reapWindowMs).toBe(IDLE_MS)
    // Per-reason gauges, so the heartbeat carries the same answer.
    expect(metrics.getGauge(`${M.idleHoldReason}{reason="refused"}`)).toBe(1)
    expect(metrics.getGauge(`${M.idleHoldReason}{reason="evictable"}`)).toBe(1)
  })
})
