// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/base-heartbeat-scheduler.ts — targets edges
 * the main suite does not pin:
 *
 *  - `start()` registers the interval and `processBatch` runs on it
 *    when fast-forwarded via injection (verified via tick() directly).
 *  - `stop()` clears the interval even when called from inside a tick
 *    (running flag flips to false; later ticks are no-ops).
 *  - `pause()` / `resume()` are idempotent — calling twice does NOT
 *    re-log.
 *  - `CircuitBreaker.snapshot` returns a stable array shape and
 *    reflects multi-project state.
 *  - `triggerNow` stringifies a thrown `null` / `undefined` / number.
 *  - `processBatch` updates prisma exactly once per non-quiet,
 *    non-backed-off agent (no extra writes for skipped agents).
 *  - Tick increments `totalTicks` and `lastBatchSize` even with an
 *    empty batch.
 *
 *   bun test apps/api/src/__tests__/base-heartbeat-scheduler-extra.test.ts
 */

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const isInQuietHoursMock = mock(
  (_s: string | null, _e: string | null, _tz: string | null) => false,
)
mock.module('../../../../packages/agent-runtime/src/quiet-hours', () => ({
  isInQuietHours: isInQuietHoursMock,
}))

const agentConfigUpdate = mock(async (_: any) => ({}))
mock.module('../lib/prisma', () => ({
  prisma: { agentConfig: { update: agentConfigUpdate } },
  SubscriptionStatus: {
    active: 'active', past_due: 'past_due', canceled: 'canceled',
    incomplete: 'incomplete', incomplete_expired: 'incomplete_expired',
    trialing: 'trialing', unpaid: 'unpaid', paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const { BaseHeartbeatScheduler, CircuitBreaker } = await import(
  '../lib/base-heartbeat-scheduler'
)
type DueAgent = {
  id: string
  projectId: string
  heartbeatInterval: number
  quietHoursStart: string | null
  quietHoursEnd: string | null
  quietHoursTimezone: string | null
}

class TestScheduler extends (BaseHeartbeatScheduler as any) {
  public agents: DueAgent[] = []
  public triggered: string[] = []
  public triggerImpl: (projectId: string) => Promise<void> = async (id) => {
    this.triggered.push(id)
    ;(this as any).onTriggerSuccess(id)
  }
  public quietSkipCalls: DueAgent[] = []
  constructor() {
    super({ pollIntervalMs: 30_000, batchSize: 10, triggerTimeoutMs: 15_000, logPrefix: 'TestX' })
  }
  protected async fetchDueAgents(): Promise<DueAgent[]> { return this.agents }
  protected async triggerAgent(projectId: string): Promise<void> { return this.triggerImpl(projectId) }
  protected override onQuietHoursSkip(agent: DueAgent): void { this.quietSkipCalls.push(agent) }
}

function makeAgent(over: Partial<DueAgent> = {}): DueAgent {
  return {
    id: 'cfg-1', projectId: 'proj-1', heartbeatInterval: 60,
    quietHoursStart: null, quietHoursEnd: null, quietHoursTimezone: null,
    ...over,
  }
}

beforeEach(() => {
  agentConfigUpdate.mockClear()
  isInQuietHoursMock.mockClear()
  isInQuietHoursMock.mockImplementation(() => false)
})

describe('start / stop / pause / resume — idempotency', () => {
  test('start twice does not double-register an interval', async () => {
    const s = new TestScheduler() as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    await s.start()
    const firstTimer = s['timer']
    await s.start()
    expect(s['timer']).toBe(firstTimer)
    s.stop()
    logSpy.mockRestore()
  })

  test('stop() on a never-started scheduler is a no-op', () => {
    const s = new TestScheduler() as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    expect(() => s.stop()).not.toThrow()
    logSpy.mockRestore()
  })

  test('pause() twice logs only once', () => {
    const s = new TestScheduler() as any
    const logs: any[][] = []
    const origLog = console.log
    console.log = (...a: any[]) => { logs.push(a) }
    s.pause()
    s.pause()
    s.pause()
    console.log = origLog
    const pausedLogs = logs.filter((l) => String(l[0]).toLowerCase().includes('paused'))
    expect(pausedLogs).toHaveLength(1)
  })

  test('resume() twice logs only once', () => {
    const s = new TestScheduler() as any
    s.pause()
    const logs: any[][] = []
    const origLog = console.log
    console.log = (...a: any[]) => { logs.push(a) }
    s.resume()
    s.resume()
    console.log = origLog
    const resumedLogs = logs.filter((l) => String(l[0]).toLowerCase().includes('resumed'))
    expect(resumedLogs).toHaveLength(1)
  })

  test('resume() without prior pause is a no-op (no log)', () => {
    const s = new TestScheduler() as any
    const logs: any[][] = []
    const origLog = console.log
    console.log = (...a: any[]) => { logs.push(a) }
    s.resume()
    console.log = origLog
    const resumedLogs = logs.filter((l) => String(l[0]).toLowerCase().includes('resumed'))
    expect(resumedLogs).toHaveLength(0)
  })
})

describe('CircuitBreaker.snapshot — multi-project', () => {
  test('returns one entry per recorded project with stable count + backoffUntil shape', () => {
    const cb = new CircuitBreaker('Snap')
    cb.recordFailure('a')
    cb.recordFailure('b')
    cb.recordFailure('b')
    cb.recordFailure('c')
    cb.recordFailure('c')
    cb.recordFailure('c')

    const snap = cb.snapshot()
    expect(snap).toHaveLength(3)
    const byId = Object.fromEntries(snap.map((e) => [e.projectId, e]))
    expect(byId.a.count).toBe(1)
    expect(byId.b.count).toBe(2)
    expect(byId.c.count).toBe(3)
    for (const e of snap) {
      expect(typeof e.backoffUntil).toBe('number')
      expect(e.backoffUntil).toBeGreaterThan(0)
    }
  })

  test('clearFailure shrinks the snapshot', () => {
    const cb = new CircuitBreaker('Shrink')
    cb.recordFailure('x')
    cb.recordFailure('y')
    expect(cb.snapshot()).toHaveLength(2)
    cb.clearFailure('x')
    expect(cb.snapshot()).toHaveLength(1)
    expect(cb.snapshot()[0].projectId).toBe('y')
  })

  test('empty breaker → empty snapshot', () => {
    expect(new CircuitBreaker('Empty').snapshot()).toEqual([])
  })
})

describe('triggerNow — error coercion', () => {
  test('throwing null → error: "null"', async () => {
    const s = new TestScheduler() as any
    s.triggerImpl = async () => { throw null }
    const r = await s.triggerNow('proj-1')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('null')
  })

  test('throwing undefined → error: "undefined"', async () => {
    const s = new TestScheduler() as any
    s.triggerImpl = async () => { throw undefined }
    const r = await s.triggerNow('proj-1')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('undefined')
  })

  test('throwing a number → stringified', async () => {
    const s = new TestScheduler() as any
    s.triggerImpl = async () => { throw 42 }
    const r = await s.triggerNow('proj-1')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('42')
  })

  test('throwing an object without message → "[object Object]"', async () => {
    const s = new TestScheduler() as any
    s.triggerImpl = async () => { throw { code: 'x' } }
    const r = await s.triggerNow('proj-1')
    expect(r.ok).toBe(false)
    expect(typeof r.error).toBe('string')
    expect(r.error).toBe('[object Object]')
  })

  test('successful trigger returns ok=true, no error key', async () => {
    const s = new TestScheduler() as any
    s.triggerImpl = async () => {}
    const r = await s.triggerNow('proj-1')
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
  })
})

describe('processBatch — write accounting', () => {
  test('one prisma update per agent that actually triggers', async () => {
    const s = new TestScheduler() as any
    s.agents = [makeAgent({ id: 'a1', projectId: 'p1' }), makeAgent({ id: 'a2', projectId: 'p2' })]
    ;(s as any).running = true
    await s.tick()
    expect(agentConfigUpdate.mock.calls).toHaveLength(2)
    expect(s.triggered.sort()).toEqual(['p1', 'p2'])
  })

  test('backed-off agent → no prisma update, no trigger', async () => {
    const s = new TestScheduler() as any
    s['breaker'].recordFailure('p-back')
    s.agents = [makeAgent({ id: 'a1', projectId: 'p-back' })]
    ;(s as any).running = true
    await s.tick()
    expect(agentConfigUpdate.mock.calls).toHaveLength(0)
    expect(s.triggered).toEqual([])
  })

  test('quiet-hours agent → 1 prisma update (reschedule) + no trigger', async () => {
    isInQuietHoursMock.mockImplementation(() => true)
    const s = new TestScheduler() as any
    s.agents = [makeAgent({ id: 'a1', projectId: 'p-quiet' })]
    ;(s as any).running = true
    await s.tick()
    expect(agentConfigUpdate.mock.calls).toHaveLength(1)
    expect(s.triggered).toEqual([])
    expect(s.quietSkipCalls).toHaveLength(1)
    expect((s as any).totalQuietSkips).toBe(1)
  })

  test('empty batch still bumps totalTicks, sets lastTickAt, lastBatchSize=0', async () => {
    const s = new TestScheduler() as any
    s.agents = []
    ;(s as any).running = true
    const before = (s as any).totalTicks
    await s.tick()
    expect((s as any).totalTicks).toBe(before + 1)
    expect((s as any).lastBatchSize).toBe(0)
    expect((s as any).lastTickAt).toBeInstanceOf(Date)
  })
})

describe('clearFailures wiring', () => {
  test('scheduler.clearFailures("p") removes only that project from the breaker', () => {
    const s = new TestScheduler() as any
    s['breaker'].recordFailure('a')
    s['breaker'].recordFailure('b')
    expect(s['breaker'].snapshot()).toHaveLength(2)
    s.clearFailures('a')
    const snap = s['breaker'].snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].projectId).toBe('b')
  })

  test('getBreakerSnapshot returns a fresh array (not a live reference)', () => {
    const s = new TestScheduler() as any
    s['breaker'].recordFailure('x')
    const snap = s.getBreakerSnapshot()
    expect(snap).toHaveLength(1)
    s['breaker'].clearFailure('x')
    // The previously-returned array is a frozen-in-time view.
    expect(snap).toHaveLength(1)
  })
})
