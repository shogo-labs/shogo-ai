// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION of the reconnect-storm bug: a user's desktop `main.log`
 * showed a ~45-minute period where the client repeatedly logged
 *
 *   [AgentChat] Stream reconnect: session=... fromSeq=0 snapshot=active@N
 *
 * roughly every 8-10 seconds. Both automatic auto-resume paths in
 * ChatPanel.tsx (the post-load live-turn probe and the stall-recovery
 * detector) are individually guarded against re-firing for the *same* turn,
 * but nothing stopped the two paths — or a freshly-reattached stream that
 * itself immediately re-stalls — from re-triggering `resumeStream()`
 * indefinitely, each time replaying the entire buffered turn from
 * `fromSeq=0` (the AI SDK's default resume convention has no way to carry
 * our custom seq cursor).
 *
 * This drives `recordAutoResumeAttempt` — the pure trip condition backing
 * `guardedAutoResumeStream` in ChatPanel.tsx — with the same cadence and
 * duration observed in the log, and asserts the breaker trips and then
 * stays tripped instead of hammering the runtime for 45 minutes.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/auto-resume-circuit-breaker.repro.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { recordAutoResumeAttempt } from '../auto-resume-circuit-breaker'

describe('REPRODUCTION: ~8-10s reconnect storm trips the auto-resume circuit breaker', () => {
  test('a storm of resumes every 9s for 45 minutes trips well before the incident duration', () => {
    let timestamps: number[] = []
    let now = 0
    let trippedAt: number | null = null
    const STORM_DURATION_MS = 45 * 60_000
    const STORM_INTERVAL_MS = 9_000

    for (now = 0; now <= STORM_DURATION_MS; now += STORM_INTERVAL_MS) {
      const result = recordAutoResumeAttempt(timestamps, now)
      timestamps = result.timestamps
      if (result.tripped) {
        trippedAt = now
        break
      }
    }

    expect(trippedAt).not.toBeNull()
    // Should trip within the first minute or two of the storm, not after
    // riding out anywhere close to the full 45-minute incident.
    expect(trippedAt!).toBeLessThan(2 * 60_000)
  })

  test('once tripped, ChatPanel stops calling recordAutoResumeAttempt (breaker latches)', () => {
    // This mirrors `guardedAutoResumeStream`: the component checks a
    // `tripped` ref BEFORE calling into `recordAutoResumeAttempt` again, so
    // once tripped the timestamp list simply stops growing — asserting that
    // shape here documents the expected call contract.
    let timestamps: number[] = []
    let tripped = false
    let callsAfterTrip = 0

    for (let i = 0; i < 20; i++) {
      const now = i * 9_000
      if (tripped) {
        callsAfterTrip++
        continue
      }
      const result = recordAutoResumeAttempt(timestamps, now)
      timestamps = result.timestamps
      if (result.tripped) tripped = true
    }

    expect(tripped).toBe(true)
    expect(callsAfterTrip).toBeGreaterThan(0)
  })

  test('a handful of legitimate reattaches (e.g. flaky wifi) does NOT trip the breaker', () => {
    let timestamps: number[] = []
    // 3 reattaches spread ~20s apart — well under the default threshold of
    // "more than 4 in 60s".
    for (const now of [0, 20_000, 40_000]) {
      const result = recordAutoResumeAttempt(timestamps, now)
      timestamps = result.timestamps
      expect(result.tripped).toBe(false)
    }
  })

  test('attempts outside the rolling window do not count toward the trip', () => {
    let timestamps: number[] = []
    // 4 attempts, each more than 60s apart — never co-resident in the window.
    for (const now of [0, 61_000, 122_000, 183_000]) {
      const result = recordAutoResumeAttempt(timestamps, now, { windowMs: 60_000, maxInWindow: 4 })
      timestamps = result.timestamps
      expect(result.tripped).toBe(false)
      // Old timestamps get pruned, so the list never grows unbounded.
      expect(timestamps.length).toBe(1)
    }
  })
})
