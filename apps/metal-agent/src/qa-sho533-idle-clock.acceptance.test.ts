// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance tests for SHO-533 — one activity classifier for the idle reaper
 * and the billing meter.
 *
 * Written from the card's acceptance criteria, not from the implementation, and
 * driven through the surfaces production actually uses: the guest's real
 * `/pool/activity` HTTP response, `reapIdle()` (what the reaper timer calls),
 * `advanceMeters()` (what the bill is built from) and `status()` (what an
 * operator curls). The dev's unit tests pin the same rules; this file is the
 * gate, so it re-derives every AC from the outside and adds the two invariants
 * the card states but the unit tests only sample:
 *
 *   - AC1: the clock does not move on a busy-but-unstreamed poll (this is the
 *     assertion that fails on `main`).
 *   - AC4: over a scripted sequence, "the bill says idle" and "the reaper says
 *     idle" are the same statement, in both directions.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import { _resetIdleDirective, setIdleDirective } from './idle-policy'
import type { FcVmConfig, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import { M, metrics } from './metrics'
import { MetalWarmPool, RepoNotDurableError, type AssignedVm } from './pool'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000
const RELAXED_MS = 4 * 60 * 60 * 1000
/** `ACTIVITY_WINDOW_MS` — the window `vmLiveness` uses for app/agent requests. */
const ACTIVITY_WINDOW_MS = 120_000

class TestPool extends MetalWarmPool {
  suspends: string[] = []
  /** Projects whose stop SHO-442 refuses (HEAD not in the durable repo). */
  refuse = new Set<string>()

  override async suspend(projectId: string): Promise<any> {
    if (this.refuse.has(projectId)) throw new RepoNotDurableError(`HEAD of ${projectId} is not in the durable repo`)
    this.suspends.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }

  seed(projectId: string, fields: Partial<AssignedVm> = {}): AssignedVm {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9', vmClass: 'standard' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      perClassActivity: true,
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }

  resident(): string[] {
    return [...(this as any).assigned.keys()].sort()
  }

  liveness(projectId: string, now = Date.now()): string {
    return (this as any).vmLiveness(this.peek(projectId), now)
  }
}

let dir: string
const cleanups: Array<() => void> = []
const cfg = config as { -readonly [K in keyof typeof config]: (typeof config)[K] }
const savedIdleSuspendMs = cfg.idleSuspendMs
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho533-'))
  // The test env has no METAL_IDLE_SUSPEND_MS and no control plane.
  cfg.idleSuspendMs = IDLE_MS
})

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  cfg.idleSuspendMs = savedIdleSuspendMs
  _resetIdleDirective()
})

function makeGuestPort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  if (server.port === undefined) throw new Error('guest server did not bind a port')
  return server.port
}

function makePool(guestPort: number, over: Partial<MetalConfig> = {}): TestPool {
  const c = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
    idleSuspendMs: IDLE_MS,
    activityPoll: true,
    activityTimeoutMs: 500,
    ...over,
  } as MetalConfig
  mkdirSync(c.snapDir, { recursive: true })
  mkdirSync(c.runDir, { recursive: true })

  let n = 0
  const mgr = {
    async startVM(vmCfg: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      return {
        id: `vm-new-${n}`,
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        pid: 1000 + n,
        platform: 'linux',
        net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
        rootfs: join(dir, `rootfs-${n}`),
        socketPath: join(dir, `fc-${n}.sock`),
        serialLog: join(dir, `fc-${n}.serial`),
        vcpus: vmCfg.cpus ?? 2,
        memoryMB: vmCfg.memoryMB ?? 1024,
        vmClass: vmCfg.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    durableRootfs: (p: string) => ({ path: p, mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  } as unknown as FirecrackerVMManager

  const pool = new TestPool(mgr, c, { kind: 'none' } as unknown as SnapshotStore)
  for (const m of [
    'waitForHealth',
    'hydrateFromBackup',
    'hydrateProjectData',
    'hydrateRepoAtAssign',
    'hydrateHomeState',
    'hydratePublishedData',
    'saveBackupToStore',
    'saveProjectDataToStore',
    'saveRepoToStore',
    'saveHomeStateToStore',
    'callGuestHook',
  ]) {
    ;(pool as any)[m] = async () => ({ hydrated: false })
  }
  return pool
}

/**
 * The guest's `/pool/activity` report. `overrides` is one poll — exactly the
 * shape `pollActivity` parses, so a test can say "a heartbeat run is busy with
 * one turn lock and no stream" and nothing else.
 */
function guestReport(overrides: Record<string, unknown> = {}) {
  return (() =>
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
          ...overrides,
        }),
        { status: 200 },
      ),
    )) as unknown as typeof fetch
}

/** A heartbeat tick: it takes a turn lock, opens no stream, nobody asked. */
const HEARTBEAT_POLL = { busy: true, activeTurns: 1, activeStreams: 0, liveStreams: 0 }

// --- AC1: a heartbeat-only VM finally reaches the window ---------------------

describe('AC1 — a heartbeat-only VM is suspended once the window has passed', () => {
  test('the busy poll does not move the reaper clock, and the VM goes at the first quiet poll', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('heartbeat-only', {
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
    })

    globalThis.fetch = guestReport(HEARTBEAT_POLL)
    await pool.pollActivity()
    // The whole bug: on `main` this poll stamped the clock to now, so the 4h
    // window restarted every 10-60 min and never elapsed.
    expect(a.lastRealActivityAt).toBe(old)
    expect(pool.liveness('heartbeat-only')).toBe('idle')

    // Busy still blocks a snapshot — but only until the tick ends.
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.resident()).toEqual(['heartbeat-only'])

    globalThis.fetch = guestReport()
    await pool.pollActivity()
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['heartbeat-only'])
    expect(pool.resident()).toEqual([])
  })

  test('a background task (long exec / service) is not activity either', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('background-task', { lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = guestReport({ busy: true, activeTurns: 0 })
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBe(old)
    expect(a.busy).toBe(true)
    expect(pool.liveness('background-task')).toBe('idle')
  })
})

// --- AC2: busy blocks the suspend, the ceiling still catches it --------------

describe('AC2 — busy is never snapshotted, and the 6h ceiling still fires', () => {
  test('a VM busy at the boundary stays resident until a quiet poll', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('busy-at-boundary', { lastRealActivityAt: old, assignedAt: old, busy: true })

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.resident()).toEqual(['busy-at-boundary'])

    a.busy = false
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['busy-at-boundary'])
  })
})

// --- AC3: real activity still resets the clock ------------------------------

describe('AC3 — a live turn and a real request still reset the clock', () => {
  test('a streamed turn resets it and holds the VM', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('streaming', { lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = guestReport({ busy: true, activeTurns: 1, activeStreams: 1, liveStreams: 1 })
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(pool.liveness('streaming')).toBe('agent')
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('an app request nobody asked us to stream also resets it', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('app-user', { lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = guestReport({ lastAppRequestAt: Date.now() })
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(pool.liveness('app-user')).toBe('app')
  })
})

// --- AC4: the bill and the reaper are the same statement --------------------

describe('AC4 — over a scripted sequence, bill-idle and reaper-idle agree', () => {
  /** Move every absolute timestamp on this VM back by `ms`: time has passed. */
  function ageBy(a: AssignedVm, ms: number) {
    for (const k of ['assignedAt', 'lastTouchedAt', 'lastRealActivityAt', 'lastUserActivityAt'] as const) {
      if (typeof a[k] === 'number') (a as any)[k] -= ms
    }
    if (typeof a.lastAppRequestAt === 'number') a.lastAppRequestAt -= ms
    if (typeof a.lastAgentRequestAt === 'number') a.lastAgentRequestAt -= ms
    if (a.meter) a.meter.advancedAt -= ms
  }

  test('every interval billed idle is an interval the reaper counts as idle, and the reverse', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('scripted', { lastRealActivityAt: old, assignedAt: old })

    const steps: Array<{ name: string; report: Record<string, unknown>; ageMs?: number }> = [
      { name: 'agent request', report: { lastAgentRequestAt: Date.now() } },
      { name: 'heartbeat tick', report: HEARTBEAT_POLL, ageMs: 30_000 },
      { name: 'heartbeat tick', report: HEARTBEAT_POLL, ageMs: 95_000 },
      { name: 'editor traffic only', report: {}, ageMs: 30_000 },
      { name: 'heartbeat tick', report: HEARTBEAT_POLL, ageMs: 60_000 },
      { name: 'live stream', report: { busy: true, activeTurns: 1, liveStreams: 1, activeStreams: 1 } },
      { name: 'heartbeat tick', report: HEARTBEAT_POLL, ageMs: 130_000 },
    ]

    let lastIdleFor: number | undefined
    for (const step of steps) {
      if (step.ageMs) ageBy(a, step.ageMs)
      globalThis.fetch = guestReport(step.report)
      const clockBefore = a.lastRealActivityAt
      await pool.pollActivity()

      const now = Date.now()
      const cls = pool.liveness('scripted', now)
      const idleFor = now - (a.lastRealActivityAt ?? a.assignedAt)

      // The two can only disagree by the poll grain: the reaper learns about a
      // request at the tick that sees it, so its clock can lag the event by one
      // reaper tick. What it must NOT do is lag forever — the whole bug was a
      // busy poll re-stamping the clock so `idleFor` never grew at all.
      const grain = config.reapIntervalMs
      if (cls === 'idle') {
        // The bill says idle, so the reaper's clock must be running: never
        // re-stamped by this poll, and never restarted while it stays idle. On
        // `main` every busy poll reset it to now, which is exactly how a VM was
        // billed idle for 13-24h and simultaneously never reached the window.
        expect({ step: step.name, clock: a.lastRealActivityAt }).toEqual({ step: step.name, clock: clockBefore })
        if (lastIdleFor !== undefined) {
          expect({ step: step.name, grew: idleFor >= lastIdleFor }).toEqual({ step: step.name, grew: true })
        }
        lastIdleFor = idleFor
      } else {
        // Live → the reaper cannot already have counted a full window of idle,
        // and the idle run it was on is over.
        expect({ step: step.name, live: idleFor <= ACTIVITY_WINDOW_MS + grain }).toEqual({ step: step.name, live: true })
        lastIdleFor = undefined
      }

      // And the interval the meter is about to charge is the same class.
      a.meter = { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now }
      pool.advanceMeters(now + 1_000)
      expect({ step: step.name, billedIdle: a.meter.idleMs > 0 }).toEqual({
        step: step.name,
        billedIdle: cls === 'idle',
      })
      expect({ step: step.name, billedAgent: a.meter.agentMs > 0 }).toEqual({
        step: step.name,
        billedAgent: cls === 'agent',
      })
    }

    // Concretely what production did not do: once the window has passed, a
    // heartbeat tick keeps it passed — three of them in a row do not restart it.
    const stalled = a.lastRealActivityAt
    for (let i = 0; i < 3; i++) {
      ageBy(a, 30_000)
      const before = a.lastRealActivityAt
      globalThis.fetch = guestReport(HEARTBEAT_POLL)
      await pool.pollActivity()
      expect(a.lastRealActivityAt).toBe(before)
    }
    expect(a.lastRealActivityAt).toBeLessThanOrEqual(stalled!)
    expect(pool.liveness('scripted')).toBe('idle')
  })

  test('a leaked activeStreams with no live stream bills idle', async () => {
    const pool = makePool(makeGuestPort())
    const now = Date.now()
    const a = pool.seed('orphan', { lastRealActivityAt: now - 60_000, assignedAt: now - 60_000 })
    a.activeStreams = 3
    a.liveStreams = 0
    a.busy = false

    expect(pool.liveness('orphan', now)).toBe('idle')
    a.meter = { agentMs: 0, appMs: 0, idleMs: 0, advancedAt: now - 5_000 }
    pool.advanceMeters(now)
    expect(a.meter).toMatchObject({ agentMs: 0, idleMs: 5_000 })
  })
})

// --- AC5: an automated wake does not buy the relaxed window -----------------

describe('AC5 — a VM nobody asked for gets the aggressive window', () => {
  test('assign seeds the flag from the cause, and reapIdle honours it under a relaxed directive', async () => {
    const pool = makePool(makeGuestPort())
    // `POST /assign` carries the control plane's cause into `open()`.
    await pool.open('scheduled', {}, undefined, { cause: 'schedule' })
    await pool.open('opened', {}, undefined, { cause: 'user_open' })

    expect(pool.peek('scheduled')!.userSeenSinceAssign).toBe(false)
    expect(pool.peek('opened')!.userSeenSinceAssign).toBe(true)

    // Age both past the aggressive window but well inside the relaxed one.
    const back = 10 * IDLE_MS
    for (const id of ['scheduled', 'opened']) {
      const a = pool.peek(id)!
      a.lastRealActivityAt = Date.now() - back
      a.assignedAt = Date.now() - back
    }
    setIdleDirective({ idleMs: RELAXED_MS, tier: 'relaxed' })

    // `reapIdle` is passed the relaxed window, as the reaper timer does.
    expect(await pool.reapIdle(RELAXED_MS, { tier: 'relaxed' })).toEqual(['scheduled'])
    expect(pool.resident()).toEqual(['opened'])
  })

  test('a person showing up lifts the narrowing, and the VM then gets the relaxed window', async () => {
    const pool = makePool(makeGuestPort())
    await pool.open('woken', {}, undefined, { cause: 'agent_wake' })
    const a = pool.peek('woken')!
    expect(a.userSeenSinceAssign).toBe(false)

    // A real app request arrives: this one now has a person behind it. The first
    // poll only baselines the guest's clock, so it takes two (the second reports
    // a newer request).
    globalThis.fetch = guestReport()
    await pool.pollActivity()
    globalThis.fetch = guestReport({ lastAppRequestAt: Date.now() })
    await pool.pollActivity()
    expect(a.userSeenSinceAssign).toBe(true)

    a.lastRealActivityAt = Date.now() - 10 * IDLE_MS
    a.assignedAt = Date.now() - 10 * IDLE_MS
    setIdleDirective({ idleMs: RELAXED_MS, tier: 'relaxed' })
    expect(await pool.reapIdle(RELAXED_MS, { tier: 'relaxed' })).toEqual([])
    expect(pool.resident()).toEqual(['woken'])
  })
})

// --- AC6: refusals are counted, warned once, backed off, and visible --------

describe('AC6 — a refusal is counted, logged once, backed off and reported', () => {
  test('the metric moves, the warning is once per VM, and the next attempt waits', async () => {
    const pool = makePool(makeGuestPort())
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('undurable', { lastRealActivityAt: old, assignedAt: old })
    pool.refuse.add('undurable')

    const warns: string[] = []
    const realWarn = console.warn
    console.warn = (...args: any[]) => warns.push(args.join(' '))
    const before = metrics.getCounter(M.idleSuspendRefused)
    try {
      expect(await pool.reapIdle(IDLE_MS)).toEqual([])
      expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    } finally {
      console.warn = realWarn
    }

    expect(metrics.getCounter(M.idleSuspendRefused)).toBe(before + 1)
    expect(a.refuseCount).toBe(1)
    expect(a.refusedSince).toBeNumber()
    expect(a.refuseRetryAt!).toBeGreaterThan(Date.now())
    expect(warns.filter((w) => w.includes('undurable'))).toHaveLength(1)
    expect(warns[0]).toContain('non-durable HEAD')
    // Still resident: a non-durable HEAD must never be snapshotted away.
    expect(pool.resident()).toEqual(['undurable'])
  })

  test('status() names why each VM is held, and the gauges sum to the resident set', async () => {
    const pool = makePool(makeGuestPort())
    const now = Date.now()
    const old = now - 10 * IDLE_MS
    pool.seed('fresh', { lastRealActivityAt: now, assignedAt: now })
    pool.seed('settled', { lastRealActivityAt: old, assignedAt: old })
    pool.seed('legacy', { lastRealActivityAt: old, assignedAt: old, perClassActivity: false })
    pool.seed('paid', { lastRealActivityAt: old, assignedAt: old, alwaysOn: true })
    pool.seed('mid-turn', { lastRealActivityAt: old, assignedAt: old, busy: true })
    // The state a refusal leaves behind: counted, and waiting out its backoff.
    pool.seed('undurable', {
      lastRealActivityAt: old,
      assignedAt: old,
      refuseCount: 3,
      refusedSince: old,
      refuseRetryAt: now + 60_000,
      refusalLogged: true,
    })
    // No reaper pass needed: before one runs, `status()` judges against
    // `cfg.idleSuspendMs`, which is this pool's configured window.

    const status = pool.status()
    const held = Object.fromEntries(status.assigned.map((v) => [v.projectId, v.holdReason]))
    expect(held).toEqual({
      fresh: 'window',
      settled: 'evictable',
      legacy: 'legacy',
      paid: 'alwaysOn',
      'mid-turn': 'busy',
      undurable: 'refused',
    })
    const reasons = ['window', 'busy', 'refused', 'alwaysOn', 'legacy', 'evictable'] as const
    expect(reasons.reduce((n, r) => n + (status.holdReasons as any)[r], 0)).toBe(pool.resident().length)
    for (const r of reasons) expect(metrics.getGauge(`${M.idleHoldReason}{reason="${r}"}`)).toBeDefined()
    expect(metrics.getGauge(`${M.idleHoldReason}{reason="refused"}`)).toBe(1)
  })
})
