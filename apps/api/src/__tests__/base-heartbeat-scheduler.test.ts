// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/base-heartbeat-scheduler.ts — the parent class that
 * powers both the production K8s scheduler and the local-dev one.
 *
 * The exports we test directly:
 *   - computeJitter           (pure)
 *   - CircuitBreaker          (pure)
 *   - BaseHeartbeatScheduler  (via a TestScheduler subclass)
 *
 * `processBatch` dynamic-imports `./prisma`; we mock it so the scheduler
 * believes it can update agentConfig rows without touching a DB.
 *
 * We also mock `../../../../packages/agent-runtime/src/quiet-hours` so
 * we can flip the quiet-hours branch deterministically.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── mocks (must happen BEFORE the dynamic import below) ──────────────────

const isInQuietHoursMock = mock(
  (_s: string | null, _e: string | null, _tz: string | null) => false,
)
mock.module('../../../../packages/agent-runtime/src/quiet-hours', () => ({
  isInQuietHours: isInQuietHoursMock,
}))

const agentConfigUpdate = mock(async (_: any) => ({}))
mock.module('../lib/prisma', () => ({
  prisma: { agentConfig: { update: agentConfigUpdate } },
  // The real `prisma.ts` re-exports enums via
  // `export * from '../generated/prisma-pg/client'`. Bun's
  // `mock.module` is module-level, so once installed it intercepts
  // every subsequent import of `../lib/prisma` — including imports
  // from sibling test files whose routes need these enums at
  // module-load time (e.g. internal-e2e-route.test.ts). Including
  // the enums here keeps those siblings passing when the runner
  // happens to load this file first.
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── load under test ──────────────────────────────────────────────────────

const {
  BaseHeartbeatScheduler,
  CircuitBreaker,
  JITTER_RATIO,
  computeJitter,
  isInQuietHours,
} = await import('../lib/base-heartbeat-scheduler')

type DueAgent = import('../lib/base-heartbeat-scheduler').DueAgent

// ─── reset between tests ──────────────────────────────────────────────────

beforeEach(() => {
  isInQuietHoursMock.mockReset()
  isInQuietHoursMock.mockImplementation(() => false)
  agentConfigUpdate.mockReset()
  agentConfigUpdate.mockImplementation(async () => ({}))
})

// ─── computeJitter ────────────────────────────────────────────────────────

describe('computeJitter', () => {
  test('JITTER_RATIO is 0.1 (export pinned)', () => {
    expect(JITTER_RATIO).toBe(0.1)
  })

  test('returns 0 when Math.random returns 0', () => {
    const orig = Math.random
    Math.random = () => 0
    try {
      expect(computeJitter(60)).toBe(0)
    } finally {
      Math.random = orig
    }
  })

  test('returns the maximum (≈ interval * ratio * 1000) when Math.random approaches 1', () => {
    const orig = Math.random
    // 0.999 → floor(0.999 * 60 * 0.1) = floor(5.994) = 5 → 5000ms
    Math.random = () => 0.999
    try {
      expect(computeJitter(60)).toBe(5000)
    } finally {
      Math.random = orig
    }
  })

  test('returns integer milliseconds — never fractional', () => {
    const orig = Math.random
    Math.random = () => 0.37
    try {
      const j = computeJitter(120)
      expect(Number.isInteger(j)).toBe(true)
      expect(j % 1000).toBe(0)
    } finally {
      Math.random = orig
    }
  })

  test('result is bounded by [0, intervalSeconds * 100] ms (i.e. 10% upper bound, in ms)', () => {
    const orig = Math.random
    try {
      for (const r of [0, 0.1, 0.25, 0.5, 0.9, 0.9999]) {
        Math.random = () => r
        const j = computeJitter(300)
        expect(j).toBeGreaterThanOrEqual(0)
        expect(j).toBeLessThanOrEqual(300 * 100) // 30_000ms
      }
    } finally {
      Math.random = orig
    }
  })

  test('intervalSeconds = 0 yields 0', () => {
    expect(computeJitter(0)).toBe(0)
  })
})

// ─── isInQuietHours re-export ─────────────────────────────────────────────

describe('isInQuietHours re-export', () => {
  test('module re-exports the helper from packages/agent-runtime/quiet-hours', () => {
    // The re-export is bound to the mocked module.
    expect(isInQuietHours).toBe(isInQuietHoursMock)
  })
})

// ─── CircuitBreaker ───────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  test('starts with no failures', () => {
    const cb = new CircuitBreaker('Test')
    expect(cb.snapshot()).toEqual([])
    expect(cb.isBackedOff('p')).toBe(false)
  })

  test('recordFailure(p) puts p into backoff (≥ 1ms in the future)', () => {
    const cb = new CircuitBreaker('Test')
    const before = Date.now()
    cb.recordFailure('p')
    const snap = cb.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].projectId).toBe('p')
    expect(snap[0].count).toBe(1)
    expect(snap[0].backoffUntil).toBeGreaterThan(before)
    expect(cb.isBackedOff('p')).toBe(true)
  })

  test('backoff schedule escalates: 5m → 15m → 60m', () => {
    const cb = new CircuitBreaker('Test')
    const t0 = Date.now()
    cb.recordFailure('p')
    const after1 = cb.snapshot()[0].backoffUntil
    cb.recordFailure('p')
    const after2 = cb.snapshot()[0].backoffUntil
    cb.recordFailure('p')
    const after3 = cb.snapshot()[0].backoffUntil

    // Use rough windows to absorb scheduler jitter.
    expect(after1 - t0).toBeGreaterThan(4 * 60_000)
    expect(after1 - t0).toBeLessThan(6 * 60_000)
    expect(after2 - t0).toBeGreaterThan(14 * 60_000)
    expect(after2 - t0).toBeLessThan(16 * 60_000)
    expect(after3 - t0).toBeGreaterThan(59 * 60_000)
    expect(after3 - t0).toBeLessThan(61 * 60_000)
  })

  test('further failures past 3 stay at the 60m cap (capped index)', () => {
    const cb = new CircuitBreaker('Test')
    const t0 = Date.now()
    for (let i = 0; i < 6; i++) cb.recordFailure('p')
    const cur = cb.snapshot()[0]
    expect(cur.count).toBe(6) // count keeps climbing
    expect(cur.backoffUntil - t0).toBeGreaterThan(59 * 60_000)
    expect(cur.backoffUntil - t0).toBeLessThan(61 * 60_000) // cap holds
  })

  test('clearFailure(p) removes the entry entirely', () => {
    const cb = new CircuitBreaker('Test')
    cb.recordFailure('p')
    cb.recordFailure('p')
    cb.clearFailure('p')
    expect(cb.isBackedOff('p')).toBe(false)
    expect(cb.snapshot()).toEqual([])
  })

  test('clearFailure for an unknown project is a no-op (no throw)', () => {
    const cb = new CircuitBreaker('Test')
    expect(() => cb.clearFailure('does-not-exist')).not.toThrow()
  })

  test('logs "consecutive failures" line when count hits the 3-strike threshold', () => {
    const errSpy = mock(() => {})
    const origError = console.error
    console.error = errSpy
    try {
      const cb = new CircuitBreaker('Test')
      cb.recordFailure('p')
      expect(errSpy).not.toHaveBeenCalled() // first hit silent
      cb.recordFailure('p')
      expect(errSpy).not.toHaveBeenCalled() // second hit silent
      cb.recordFailure('p')
      expect(errSpy).toHaveBeenCalledTimes(1)
      const msg = (errSpy.mock.calls[0] as any[]).join(' ')
      expect(msg).toContain('[Test]')
      expect(msg).toContain('Project p hit 3 consecutive failures')
      expect(msg).toContain('60m') // matches the cap
    } finally {
      console.error = origError
    }
  })

  test('tracks failures per project independently', () => {
    const cb = new CircuitBreaker('Test')
    cb.recordFailure('a')
    cb.recordFailure('b')
    cb.recordFailure('b')
    const snap = new Map(cb.snapshot().map((e) => [e.projectId, e]))
    expect(snap.get('a')?.count).toBe(1)
    expect(snap.get('b')?.count).toBe(2)
  })

  test('isBackedOff returns false once the backoff window expires', () => {
    const cb = new CircuitBreaker('Test')
    cb.recordFailure('p')
    // Force the entry's backoffUntil into the past.
    const entry = (cb as any).failures.get('p')
    entry.backoffUntil = Date.now() - 1
    expect(cb.isBackedOff('p')).toBe(false)
  })
})

// ─── BaseHeartbeatScheduler via TestScheduler ─────────────────────────────

class TestScheduler extends BaseHeartbeatScheduler {
  public agents: DueAgent[] = []
  public triggered: string[] = []
  public triggerImpl: (projectId: string) => Promise<void> = async (id) => {
    this.triggered.push(id)
    this.onTriggerSuccess(id)
  }
  public quietSkipCalls: DueAgent[] = []

  constructor(opts: Partial<{ pollIntervalMs: number; batchSize: number; triggerTimeoutMs: number }> = {}) {
    super({
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
      batchSize: opts.batchSize ?? 10,
      triggerTimeoutMs: opts.triggerTimeoutMs ?? 15_000,
      logPrefix: 'Test',
    })
  }

  protected async fetchDueAgents(): Promise<DueAgent[]> {
    return this.agents
  }

  protected async triggerAgent(projectId: string): Promise<void> {
    return this.triggerImpl(projectId)
  }

  protected override onQuietHoursSkip(agent: DueAgent): void {
    this.quietSkipCalls.push(agent)
  }
}

function makeAgent(over: Partial<DueAgent> = {}): DueAgent {
  return {
    id: 'cfg-1',
    projectId: 'proj-1',
    heartbeatInterval: 60,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursTimezone: null,
    ...over,
  }
}

afterEach(() => {
  // No timers should leak from start/stop in tests.
})

describe('BaseHeartbeatScheduler — lifecycle', () => {
  test('isRunning / isPaused start false', () => {
    const s = new TestScheduler()
    expect(s.isRunning()).toBe(false)
    expect(s.isPaused()).toBe(false)
  })

  test('start sets running, stamps startedAt, registers an interval', async () => {
    const s = new TestScheduler()
    const before = Date.now()
    await s.start()
    try {
      expect(s.isRunning()).toBe(true)
      const stats = s.getStats()
      expect(stats.running).toBe(true)
      expect(stats.startedAt).toBeInstanceOf(Date)
      expect(stats.startedAt!.getTime()).toBeGreaterThanOrEqual(before)
    } finally {
      s.stop()
    }
  })

  test('start is idempotent — calling twice does not re-initialize', async () => {
    const s = new TestScheduler()
    await s.start()
    const firstStartedAt = s.getStats().startedAt
    await s.start()
    expect(s.getStats().startedAt).toBe(firstStartedAt!)
    s.stop()
  })

  test('stop clears running and the interval', async () => {
    const s = new TestScheduler()
    await s.start()
    expect(s.isRunning()).toBe(true)
    s.stop()
    expect(s.isRunning()).toBe(false)
  })

  test('pause / resume toggle the flag and log once each', () => {
    const s = new TestScheduler()
    s.pause()
    expect(s.isPaused()).toBe(true)
    s.pause() // second call early-returns
    expect(s.isPaused()).toBe(true)
    s.resume()
    expect(s.isPaused()).toBe(false)
    s.resume() // second call early-returns
    expect(s.isPaused()).toBe(false)
  })
})

describe('BaseHeartbeatScheduler — tick gating', () => {
  test('tick is a no-op when not running', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    await s.tick()
    expect(s.triggered).toEqual([])
    expect(s.getStats().totalTicks).toBe(0)
  })

  test('tick processes the batch when running', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent({ projectId: 'A' }), makeAgent({ id: 'cfg-2', projectId: 'B' })]
    await s.start()
    try {
      await s.tick()
      expect(s.triggered.sort()).toEqual(['A', 'B'])
      const stats = s.getStats()
      expect(stats.totalTicks).toBe(1)
      expect(stats.lastBatchSize).toBe(2)
      expect(stats.totalTriggered).toBe(2)
      expect(stats.lastTickAt).toBeInstanceOf(Date)
    } finally {
      s.stop()
    }
  })

  test('empty batch updates stats but does not call triggerAgent or prisma', async () => {
    const s = new TestScheduler()
    await s.start()
    try {
      await s.tick()
      expect(s.triggered).toEqual([])
      expect(agentConfigUpdate).not.toHaveBeenCalled()
      const stats = s.getStats()
      expect(stats.totalTicks).toBe(1)
      expect(stats.lastBatchSize).toBe(0)
    } finally {
      s.stop()
    }
  })

  test('paused scheduler increments NOTHING — early return before prisma import', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    await s.start()
    s.pause()
    try {
      await s.tick()
      expect(s.triggered).toEqual([])
      expect(s.getStats().totalTicks).toBe(0) // processBatch returned early
    } finally {
      s.stop()
    }
  })

  test('concurrent tick() calls — second one no-ops because tickInProgress is set', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    // Make triggerAgent slow so the first tick is still running.
    let release: () => void = () => {}
    const pending = new Promise<void>((r) => (release = r))
    s.triggerImpl = async (id) => {
      await pending
      s.triggered.push(id)
      s.onTriggerSuccess(id)
    }
    await s.start()
    try {
      const first = s.tick()
      const second = s.tick() // should early-return immediately
      await second
      expect(s.triggered).toEqual([]) // first one not done yet
      release()
      await first
      expect(s.triggered).toEqual(['proj-1'])
      // Only one tick was counted.
      expect(s.getStats().totalTicks).toBe(1)
    } finally {
      s.stop()
    }
  })
})

describe('BaseHeartbeatScheduler — quiet hours + breaker integration', () => {
  test('quiet-hours hit: increments totalQuietSkips, calls onQuietHoursSkip, advances next time, does NOT trigger', async () => {
    isInQuietHoursMock.mockImplementation(() => true)
    const s = new TestScheduler()
    s.agents = [makeAgent({ quietHoursStart: '22:00', quietHoursEnd: '06:00' })]
    await s.start()
    try {
      await s.tick()
      expect(s.triggered).toEqual([])
      expect(s.quietSkipCalls).toHaveLength(1)
      expect(s.quietSkipCalls[0].id).toBe('cfg-1')
      expect(s.getStats().totalQuietSkips).toBe(1)
      // prisma.agentConfig.update was still called to push nextHeartbeatAt
      expect(agentConfigUpdate).toHaveBeenCalledTimes(1)
      expect(agentConfigUpdate.mock.calls[0][0].where).toEqual({ id: 'cfg-1' })
    } finally {
      s.stop()
    }
  })

  test('circuit-breaker backoff skips trigger entirely (no prisma update, no trigger)', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    // Force the breaker into backoff before the tick.
    ;(s as any).breaker.recordFailure('proj-1')
    await s.start()
    try {
      await s.tick()
      expect(s.triggered).toEqual([])
      expect(agentConfigUpdate).not.toHaveBeenCalled()
      // Stats: tick happened, but no triggers
      expect(s.getStats().totalTriggered).toBe(0)
    } finally {
      s.stop()
    }
  })

  test('mixed batch: backed-off agent skipped, quiet agent skipped+rescheduled, normal agent triggered', async () => {
    isInQuietHoursMock.mockImplementation((s, _e, _tz) => s === '22:00')
    const sched = new TestScheduler()
    sched.agents = [
      makeAgent({ id: 'cfg-A', projectId: 'A' }),
      makeAgent({ id: 'cfg-B', projectId: 'B', quietHoursStart: '22:00' }),
      makeAgent({ id: 'cfg-C', projectId: 'C' }),
    ]
    ;(sched as any).breaker.recordFailure('C') // C is backed off
    await sched.start()
    try {
      await sched.tick()
      expect(sched.triggered).toEqual(['A'])
      expect(sched.quietSkipCalls.map((a) => a.projectId)).toEqual(['B'])
      // A and B both got prisma updates (normal + quiet reschedule).
      // C was skipped entirely.
      expect(agentConfigUpdate).toHaveBeenCalledTimes(2)
      const ids = agentConfigUpdate.mock.calls.map((c: any[]) => c[0].where.id).sort()
      expect(ids).toEqual(['cfg-A', 'cfg-B'])
    } finally {
      sched.stop()
    }
  })
})

describe('BaseHeartbeatScheduler — trigger outcomes', () => {
  test('successful trigger bumps totalTriggered via onTriggerSuccess', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    await s.start()
    try {
      await s.tick()
      expect(s.getStats().totalTriggered).toBe(1)
      expect(s.getStats().totalFailed).toBe(0)
    } finally {
      s.stop()
    }
  })

  test('failed trigger inside triggerAgent does NOT bubble (Promise.allSettled) and bumps totalFailed when subclass calls onTriggerFailure', async () => {
    const s = new TestScheduler()
    s.agents = [makeAgent()]
    s.triggerImpl = async (id) => {
      s.onTriggerFailure(id, new Error('boom'))
      throw new Error('boom')
    }
    await s.start()
    try {
      await s.tick() // must NOT throw
      expect(s.getStats().totalFailed).toBe(1)
      expect(s.getStats().totalTriggered).toBe(0)
    } finally {
      s.stop()
    }
  })

  test('triggerNow() bypasses pause + breaker — returns ok:true on success', async () => {
    const s = new TestScheduler()
    s.pause()
    ;(s as any).breaker.recordFailure('proj-1')
    const result = await s.triggerNow('proj-1')
    expect(result).toEqual({ ok: true })
    expect(s.triggered).toEqual(['proj-1'])
  })

  test('triggerNow() returns ok:false + error.message when triggerAgent throws', async () => {
    const s = new TestScheduler()
    s.triggerImpl = async () => {
      throw new Error('runtime unreachable')
    }
    const result = await s.triggerNow('proj-1')
    expect(result).toEqual({ ok: false, error: 'runtime unreachable' })
  })

  test('triggerNow() stringifies non-Error throws', async () => {
    const s = new TestScheduler()
    s.triggerImpl = async () => {
      throw 'plain-string-error'
    }
    const result = await s.triggerNow('proj-1')
    expect(result).toEqual({ ok: false, error: 'plain-string-error' })
  })

  test('clearFailures(projectId) delegates to the breaker', () => {
    const s = new TestScheduler()
    ;(s as any).breaker.recordFailure('proj-X')
    expect((s as any).breaker.isBackedOff('proj-X')).toBe(true)
    s.clearFailures('proj-X')
    expect((s as any).breaker.isBackedOff('proj-X')).toBe(false)
  })

  test('getBreakerSnapshot exposes the breaker contents', () => {
    const s = new TestScheduler()
    ;(s as any).breaker.recordFailure('proj-X')
    const snap = s.getBreakerSnapshot()
    expect(snap.map((e) => e.projectId)).toEqual(['proj-X'])
    expect(snap[0].count).toBe(1)
  })
})

describe('BaseHeartbeatScheduler — getStats', () => {
  test('reflects config values verbatim', () => {
    const s = new TestScheduler({
      pollIntervalMs: 1234,
      batchSize: 7,
      triggerTimeoutMs: 9876,
    })
    const stats = s.getStats()
    expect(stats.pollIntervalMs).toBe(1234)
    expect(stats.batchSize).toBe(7)
    expect(stats.triggerTimeoutMs).toBe(9876)
    expect(stats.logPrefix).toBe('Test')
  })

  test('lastTickDurationMs is non-negative after a tick', async () => {
    const s = new TestScheduler()
    s.agents = []
    await s.start()
    try {
      await s.tick()
      expect(s.getStats().lastTickDurationMs).toBeGreaterThanOrEqual(0)
    } finally {
      s.stop()
    }
  })
})
