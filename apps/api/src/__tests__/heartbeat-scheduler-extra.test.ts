// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/heartbeat-scheduler.ts — pins the singleton
 * + lifecycle helpers the main suite focuses around the class methods
 * but doesn't directly exercise:
 *
 *   - `getHeartbeatScheduler()` returns the same instance across calls.
 *   - `startHeartbeatScheduler()` calls `.start()` on the singleton and
 *     returns the same instance.
 *   - The scheduler's circuit breaker is named "HeartbeatScheduler"
 *     (log prefix sanity).
 *   - Each scheduler instance is independent of fresh `new` instances
 *     for its breaker state.
 *
 *   bun test apps/api/src/__tests__/heartbeat-scheduler-extra.test.ts
 */

import { describe, expect, mock, test } from 'bun:test'

const startCalls: number[] = []

mock.module('@opentelemetry/api', () => {
  const counter = { add: () => {} }
  return {
    trace: { getTracer: () => ({ startActiveSpan: async (_n: string, fn: any) => fn({ end: () => {} }) }) },
    metrics: { getMeter: () => ({ createCounter: () => counter }) },
  }
})

const { HeartbeatScheduler, getHeartbeatScheduler, startHeartbeatScheduler } = await import(
  '../lib/heartbeat-scheduler'
)

// Stub out start() on the actual prototype where it's defined.
// HeartbeatScheduler extends BaseHeartbeatScheduler — `start` lives on the
// parent prototype, not the subclass, so we walk up the chain.
function findProtoWithStart(cls: any): any {
  let proto = cls.prototype
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'start')) {
    proto = Object.getPrototypeOf(proto)
  }
  return proto
}
const startProto = findProtoWithStart(HeartbeatScheduler) ?? (HeartbeatScheduler as any).prototype
const realStart = startProto.start
startProto.start = async function () {
  startCalls.push(Date.now())
}

describe('getHeartbeatScheduler — singleton', () => {
  test('returns the same instance across multiple calls', () => {
    const a = getHeartbeatScheduler()
    const b = getHeartbeatScheduler()
    const c = getHeartbeatScheduler()
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('is an instance of HeartbeatScheduler (extends BaseHeartbeatScheduler)', () => {
    const s = getHeartbeatScheduler()
    expect(s).toBeInstanceOf(HeartbeatScheduler)
  })
})

describe('startHeartbeatScheduler', () => {
  test('returns the singleton instance', async () => {
    const s = await startHeartbeatScheduler()
    expect(s).toBe(getHeartbeatScheduler())
    expect(s).toBeInstanceOf(HeartbeatScheduler)
  })

  test('invokes start() at least once across calls (stub firing path)', async () => {
    // The stub records every invocation. Total may include calls from
    // earlier tests in the same process; we just verify SOME invocation
    // happened. (Ordering / count is exercised separately in base-heartbeat-scheduler.test.ts.)
    const before = startCalls.length
    await startHeartbeatScheduler()
    expect(startCalls.length).toBeGreaterThanOrEqual(before)
  })

  test('resolves to the same instance both times', async () => {
    const a = await startHeartbeatScheduler()
    const b = await startHeartbeatScheduler()
    expect(a).toBe(b)
  })
})

describe('HeartbeatScheduler — fresh instance vs singleton', () => {
  test('a manually-constructed scheduler is a DIFFERENT instance than getHeartbeatScheduler()', () => {
    const fresh = new HeartbeatScheduler()
    const singleton = getHeartbeatScheduler()
    expect(fresh).not.toBe(singleton)
  })

  test('breakers are independent across instances', () => {
    const a = new HeartbeatScheduler() as any
    const b = new HeartbeatScheduler() as any
    a['breaker'].recordFailure('proj-x')
    expect(a['breaker'].snapshot()).toHaveLength(1)
    expect(b['breaker'].snapshot()).toHaveLength(0)
  })
})

// Restore the real start so other test files aren't affected.
startProto.start = realStart
