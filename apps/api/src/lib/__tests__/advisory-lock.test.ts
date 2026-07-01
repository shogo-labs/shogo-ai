// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the bounded, non-blocking advisory-lock poll. Driven
 * entirely through injected deps — no Postgres required.
 *
 *   bun test apps/api/src/lib/__tests__/advisory-lock.test.ts
 */

import { describe, expect, it } from 'bun:test'
import { pollAdvisoryLock } from '../advisory-lock'

/** A deterministic fake clock + sleep so tests never touch real timers. */
function fakeClock(startedAt = 0) {
  let t = startedAt
  return {
    now: () => t,
    // "Sleeping" just advances the virtual clock.
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('pollAdvisoryLock', () => {
  it('acquires on the first try without sleeping (uncontended)', async () => {
    const clock = fakeClock()
    let tries = 0
    let sleeps = 0
    const got = await pollAdvisoryLock(
      1,
      {
        tryLock: async () => {
          tries++
          return true
        },
        now: clock.now,
        sleep: async (ms) => {
          sleeps++
          await clock.sleep(ms)
        },
      },
      { budgetMs: 5000 },
    )
    expect(got).toBe(true)
    expect(tries).toBe(1)
    expect(sleeps).toBe(0)
  })

  it('retries with backoff and succeeds once the lock frees', async () => {
    const clock = fakeClock()
    let tries = 0
    const got = await pollAdvisoryLock(
      1,
      {
        // Free on the 3rd attempt.
        tryLock: async () => {
          tries++
          return tries >= 3
        },
        now: clock.now,
        sleep: clock.sleep,
      },
      { budgetMs: 10_000, initialIntervalMs: 100, maxIntervalMs: 1000 },
    )
    expect(got).toBe(true)
    expect(tries).toBe(3)
  })

  it('gives up (returns false) when the budget is exhausted', async () => {
    const clock = fakeClock()
    let tries = 0
    const got = await pollAdvisoryLock(
      1,
      {
        tryLock: async () => {
          tries++
          return false
        },
        now: clock.now,
        sleep: clock.sleep,
      },
      { budgetMs: 1000, initialIntervalMs: 100, maxIntervalMs: 400 },
    )
    expect(got).toBe(false)
    // Never blocks: it kept trying but bailed at the deadline.
    expect(tries).toBeGreaterThan(1)
  })

  it('caps the backoff interval at maxIntervalMs', async () => {
    const clock = fakeClock()
    const sleepDurations: number[] = []
    await pollAdvisoryLock(
      1,
      {
        tryLock: async () => false,
        now: clock.now,
        sleep: async (ms) => {
          sleepDurations.push(ms)
          await clock.sleep(ms)
        },
      },
      { budgetMs: 10_000, initialIntervalMs: 100, maxIntervalMs: 500 },
    )
    // Exponential 100,200,400 then capped at 500 (final one may be clamped to
    // the remaining budget, so assert none EXCEED the cap).
    expect(sleepDurations.every((d) => d <= 500)).toBe(true)
    expect(sleepDurations.some((d) => d === 500)).toBe(true)
  })
})
