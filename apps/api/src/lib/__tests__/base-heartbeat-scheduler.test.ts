// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the admin-facing surface of BaseHeartbeatScheduler:
 *   pause/resume, getStats, getBreakerSnapshot, triggerNow, clearFailures.
 *
 * Uses a fake subclass with stubbed fetchDueAgents/triggerAgent so we don't
 * need a live database.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  BaseHeartbeatScheduler,
  CircuitBreaker,
  computeJitter,
  type DueAgent,
} from '../base-heartbeat-scheduler'

const agentConfigUpdateMock = mock(async (_args: any) => ({}))

mock.module('../prisma', () => ({
  prisma: {
    agentConfig: {
      update: agentConfigUpdateMock,
    },
  },
}))

class FakeScheduler extends BaseHeartbeatScheduler {
  triggerCalls: string[] = []
  triggerError: Error | null = null
  dueAgents: DueAgent[] = []
  quietSkips: DueAgent[] = []

  constructor() {
    super({
      pollIntervalMs: 60_000,
      batchSize: 10,
      triggerTimeoutMs: 5_000,
      logPrefix: 'FakeHeartbeat',
    })
  }

  protected async fetchDueAgents(): Promise<DueAgent[]> {
    return this.dueAgents
  }

  protected async triggerAgent(projectId: string): Promise<void> {
    this.triggerCalls.push(projectId)
    if (this.triggerError) {
      const err = this.triggerError
      this.triggerError = null
      this.breaker.recordFailure(projectId)
      this.onTriggerFailure(projectId, err)
      throw err
    }
    this.breaker.clearFailure(projectId)
    this.onTriggerSuccess(projectId)
  }

  protected onQuietHoursSkip(agent: DueAgent): void {
    this.quietSkips.push(agent)
  }
}

describe('BaseHeartbeatScheduler admin controls', () => {
  let scheduler: FakeScheduler

  beforeEach(() => {
    scheduler = new FakeScheduler()
    agentConfigUpdateMock.mockClear()
  })

  test('computeJitter returns milliseconds within the configured jitter window', () => {
    const values = Array.from({ length: 20 }, () => computeJitter(100))
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(9_000)
      expect(value % 1000).toBe(0)
    }
  })

  test('pause/resume toggles the paused flag and is idempotent', () => {
    expect(scheduler.isPaused()).toBe(false)
    scheduler.pause()
    expect(scheduler.isPaused()).toBe(true)
    scheduler.pause()
    expect(scheduler.isPaused()).toBe(true)
    scheduler.resume()
    expect(scheduler.isPaused()).toBe(false)
    scheduler.resume()
    expect(scheduler.isPaused()).toBe(false)
  })

  test('getStats reports running/paused state and config', () => {
    const before = scheduler.getStats()
    expect(before.running).toBe(false)
    expect(before.paused).toBe(false)
    expect(before.startedAt).toBeNull()
    expect(before.lastTickAt).toBeNull()
    expect(before.totalTicks).toBe(0)
    expect(before.totalTriggered).toBe(0)
    expect(before.totalFailed).toBe(0)
    expect(before.pollIntervalMs).toBe(60_000)
    expect(before.batchSize).toBe(10)
    expect(before.logPrefix).toBe('FakeHeartbeat')

    scheduler.pause()
    expect(scheduler.getStats().paused).toBe(true)
  })

  test('start and stop toggle running state and are idempotent', async () => {
    await scheduler.start()
    expect(scheduler.isRunning()).toBe(true)
    expect(scheduler.getStats().startedAt).toBeInstanceOf(Date)

    await scheduler.start()
    expect(scheduler.isRunning()).toBe(true)

    scheduler.stop()
    expect(scheduler.isRunning()).toBe(false)
    scheduler.stop()
    expect(scheduler.isRunning()).toBe(false)
  })

  test('scheduled interval does not overlap ticks already in progress', async () => {
    let captured: (() => void) | null = null
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const releaseTick = Promise.withResolvers<void>()

    class SlowScheduler extends FakeScheduler {
      protected async runTick(): Promise<void> {
        await releaseTick.promise
        await super.runTick()
      }
    }

    try {
      ;(globalThis as any).setInterval = (fn: () => void) => {
        captured = fn
        return 1
      }
      ;(globalThis as any).clearInterval = () => {}
      const slow = new SlowScheduler()
      await slow.start()

      captured!()
      captured!()
      releaseTick.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(slow.getStats().totalTicks).toBe(1)
      slow.stop()
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('scheduled interval logs tick errors without throwing from callback', async () => {
    let captured: (() => void) | null = null
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const originalConsoleError = console.error
    const errors: any[] = []

    class ThrowingScheduler extends FakeScheduler {
      protected async runTick(): Promise<void> {
        throw new Error('tick exploded')
      }
    }

    try {
      ;(globalThis as any).setInterval = (fn: () => void) => {
        captured = fn
        return 1
      }
      ;(globalThis as any).clearInterval = () => {}
      console.error = (...args: any[]) => { errors.push(args) }
      const throwing = new ThrowingScheduler()
      await throwing.start()

      expect(() => captured!()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(errors[0][0]).toContain('[FakeHeartbeat] Tick error:')
      expect(errors[0][1]).toBe('tick exploded')
      throwing.stop()
    } finally {
      console.error = originalConsoleError
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  test('tick is ignored while stopped or already in progress', async () => {
    scheduler.dueAgents = [{ id: 'agent-1', projectId: 'proj-1', heartbeatInterval: 60 }]

    await scheduler.tick()

    expect(scheduler.triggerCalls).toEqual([])
    expect(agentConfigUpdateMock).not.toHaveBeenCalled()
  })

  test('triggerNow returns ok:true on success and bumps totalTriggered', async () => {
    const result = await scheduler.triggerNow('proj-a')
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(scheduler.triggerCalls).toEqual(['proj-a'])
    expect(scheduler.getStats().totalTriggered).toBe(1)
    expect(scheduler.getStats().totalFailed).toBe(0)
  })

  test('triggerNow returns ok:false with error message on failure and bumps totalFailed', async () => {
    scheduler.triggerError = new Error('runtime unreachable')
    const result = await scheduler.triggerNow('proj-b')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('runtime unreachable')
    expect(scheduler.getStats().totalFailed).toBe(1)
    expect(scheduler.getStats().totalTriggered).toBe(0)
  })

  test('triggerNow records a circuit-breaker entry on failure that getBreakerSnapshot returns', async () => {
    scheduler.triggerError = new Error('boom')
    await scheduler.triggerNow('proj-c')
    const snap = scheduler.getBreakerSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].projectId).toBe('proj-c')
    expect(snap[0].count).toBe(1)
    expect(snap[0].backoffUntil).toBeGreaterThan(Date.now())
  })

  test('clearFailures removes an existing breaker entry', async () => {
    scheduler.triggerError = new Error('boom')
    await scheduler.triggerNow('proj-d')
    expect(scheduler.getBreakerSnapshot()).toHaveLength(1)

    scheduler.clearFailures('proj-d')
    expect(scheduler.getBreakerSnapshot()).toHaveLength(0)
  })

  test('clearFailures on an unknown project is a no-op', () => {
    expect(() => scheduler.clearFailures('does-not-exist')).not.toThrow()
    expect(scheduler.getBreakerSnapshot()).toHaveLength(0)
  })

  test('triggerNow on success after a prior failure clears the breaker entry', async () => {
    scheduler.triggerError = new Error('boom')
    await scheduler.triggerNow('proj-e')
    expect(scheduler.getBreakerSnapshot()).toHaveLength(1)

    const ok = await scheduler.triggerNow('proj-e')
    expect(ok.ok).toBe(true)
    expect(scheduler.getBreakerSnapshot()).toHaveLength(0)
  })

  test('multiple failures increase the breaker count and extend backoff', async () => {
    scheduler.triggerError = new Error('1')
    await scheduler.triggerNow('proj-f')
    scheduler.triggerError = new Error('2')
    await scheduler.triggerNow('proj-f')

    const snap = scheduler.getBreakerSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].count).toBe(2)
  })

  test('tick records an empty batch without triggering agents', async () => {
    await scheduler.start()

    await scheduler.tick()

    const stats = scheduler.getStats()
    expect(stats.totalTicks).toBe(1)
    expect(stats.lastBatchSize).toBe(0)
    expect(stats.lastTickAt).toBeInstanceOf(Date)
    expect(scheduler.triggerCalls).toEqual([])
    scheduler.stop()
  })

  test('tick advances due agents and triggers them', async () => {
    await scheduler.start()
    scheduler.dueAgents = [
      { id: 'agent-1', projectId: 'proj-1', heartbeatInterval: 60 },
      { id: 'agent-2', projectId: 'proj-2', heartbeatInterval: 120 },
    ]

    await scheduler.tick()

    expect(agentConfigUpdateMock).toHaveBeenCalledTimes(2)
    expect(agentConfigUpdateMock.mock.calls[0][0].where).toEqual({ id: 'agent-1' })
    expect(agentConfigUpdateMock.mock.calls[1][0].where).toEqual({ id: 'agent-2' })
    expect(scheduler.triggerCalls).toEqual(['proj-1', 'proj-2'])
    expect(scheduler.getStats().totalTriggered).toBe(2)
    expect(scheduler.getStats().lastBatchSize).toBe(2)
    scheduler.stop()
  })

  test('tick skips processing while paused', async () => {
    await scheduler.start()
    scheduler.pause()
    scheduler.dueAgents = [{ id: 'agent-1', projectId: 'proj-1', heartbeatInterval: 60 }]

    await scheduler.tick()

    expect(scheduler.getStats().totalTicks).toBe(0)
    expect(scheduler.triggerCalls).toEqual([])
    expect(agentConfigUpdateMock).not.toHaveBeenCalled()
    scheduler.stop()
  })

  test('tick skips backed-off projects before updating their schedule', async () => {
    await scheduler.start()
    scheduler.triggerError = new Error('boom')
    await scheduler.triggerNow('proj-backoff')
    scheduler.dueAgents = [
      { id: 'agent-1', projectId: 'proj-backoff', heartbeatInterval: 60 },
      { id: 'agent-2', projectId: 'proj-ok', heartbeatInterval: 60 },
    ]
    scheduler.triggerCalls = []

    await scheduler.tick()

    expect(scheduler.triggerCalls).toEqual(['proj-ok'])
    expect(agentConfigUpdateMock).toHaveBeenCalledTimes(1)
    expect(agentConfigUpdateMock.mock.calls[0][0].where).toEqual({ id: 'agent-2' })
    scheduler.stop()
  })

  test('tick advances quiet-hours agents without triggering them', async () => {
    await scheduler.start()
    scheduler.dueAgents = [{
      id: 'agent-quiet',
      projectId: 'proj-quiet',
      heartbeatInterval: 60,
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTimezone: 'UTC',
    }]

    await scheduler.tick()

    expect(scheduler.triggerCalls).toEqual([])
    expect(scheduler.quietSkips.map((agent) => agent.projectId)).toEqual(['proj-quiet'])
    expect(scheduler.getStats().totalQuietSkips).toBe(1)
    expect(agentConfigUpdateMock).toHaveBeenCalledWith({
      where: { id: 'agent-quiet' },
      data: { nextHeartbeatAt: expect.any(Date) },
    })
    scheduler.stop()
  })

  test('trigger failures during a tick are settled and reflected in stats', async () => {
    await scheduler.start()
    scheduler.triggerError = new Error('runtime down')
    scheduler.dueAgents = [{ id: 'agent-1', projectId: 'proj-fail', heartbeatInterval: 60 }]

    await expect(scheduler.tick()).resolves.toBeUndefined()

    expect(scheduler.getStats().totalFailed).toBe(1)
    expect(scheduler.getBreakerSnapshot()[0].projectId).toBe('proj-fail')
    scheduler.stop()
  })
})

describe('CircuitBreaker.snapshot', () => {
  test('returns an empty array when no failures have been recorded', () => {
    const breaker = new CircuitBreaker('test')
    expect(breaker.snapshot()).toEqual([])
  })

  test('returns one entry per project that has failed', () => {
    const breaker = new CircuitBreaker('test')
    breaker.recordFailure('a')
    breaker.recordFailure('a')
    breaker.recordFailure('b')

    const snap = breaker.snapshot()
    expect(snap).toHaveLength(2)
    const a = snap.find((e) => e.projectId === 'a')
    const b = snap.find((e) => e.projectId === 'b')
    expect(a?.count).toBe(2)
    expect(b?.count).toBe(1)
    expect(a?.backoffUntil).toBeGreaterThan(Date.now())
  })

  test('clearFailure removes a project from the snapshot', () => {
    const breaker = new CircuitBreaker('test')
    breaker.recordFailure('a')
    breaker.recordFailure('b')
    breaker.clearFailure('a')

    const snap = breaker.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].projectId).toBe('b')
  })
})
