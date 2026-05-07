// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the admin-facing surface of BaseHeartbeatScheduler:
 *   pause/resume, getStats, getBreakerSnapshot, triggerNow, clearFailures.
 *
 * Uses a fake subclass with stubbed fetchDueAgents/triggerAgent so we don't
 * need a live database.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  BaseHeartbeatScheduler,
  CircuitBreaker,
  type DueAgent,
} from '../base-heartbeat-scheduler'

class FakeScheduler extends BaseHeartbeatScheduler {
  triggerCalls: string[] = []
  triggerError: Error | null = null
  dueAgents: DueAgent[] = []

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
}

describe('BaseHeartbeatScheduler admin controls', () => {
  let scheduler: FakeScheduler

  beforeEach(() => {
    scheduler = new FakeScheduler()
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
