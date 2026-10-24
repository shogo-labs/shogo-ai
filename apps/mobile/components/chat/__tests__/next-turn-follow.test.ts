// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-29 (`e2e/local/chat-resume-on-send.test.ts:677`, window A, reply "uc"):
 *
 * Two windows are open before a turn starts elsewhere, both send, so the API
 * queues both messages behind the live turn. The window follows the lead turn
 * and the first queued reply, then the second queued reply runs and finishes
 * between its two probes and it never paints it — the transcript looks idle
 * while a turn that did run is missing from it.
 *
 * These tests drive the follow directly, the way `late-turn-attach`'s
 * integration test drives `pollForLateTurn`.
 */

import { describe, expect, test } from 'bun:test'
import { followNextTurn, NEXT_TURN_PROBE_GAPS_MS } from '../next-turn-follow'

/** Records when each probe would have fired, without waiting. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('following the turn after the one this window was attached to', () => {
  test('a queued reply that starts and finishes between the probes still lands', async () => {
    // The queue dispatcher starts the second queued message after the first
    // one ends, and a 60-token reply is short enough that no probe catches it
    // running. Nothing to attach to, so the history has to be reloaded.
    const time = clock()
    let probes = 0
    let refreshes = 0
    const result = await followNextTurn({
      attachIfLive: async () => {
        probes += 1
        return false
      },
      refreshHistory: () => {
        refreshes += 1
      },
      sleep: time.sleep,
    })
    expect(result).toBe('refreshed')
    expect(probes).toBe(NEXT_TURN_PROBE_GAPS_MS.length)
    expect(refreshes).toBe(1)
  })

  test('keeps looking past the old 4s landmark', async () => {
    // The turn is up by 8s — well after the 1.5s and 4s probes the panel used
    // to stop at — and must still be attached to rather than reloaded.
    const time = clock()
    const probesAt: number[] = []
    let refreshes = 0
    const result = await followNextTurn({
      attachIfLive: async () => {
        probesAt.push(time.now())
        return time.now() >= 8000
      },
      refreshHistory: () => {
        refreshes += 1
      },
      sleep: time.sleep,
    })
    expect(result).toBe('attached')
    expect(probesAt).toEqual([1500, 4000, 8000])
    expect(refreshes).toBe(0)
  })

  test('a live turn is attached to once and the follow stops', async () => {
    const time = clock()
    let probes = 0
    let refreshes = 0
    const result = await followNextTurn({
      attachIfLive: async () => {
        probes += 1
        return true
      },
      refreshHistory: () => {
        refreshes += 1
      },
      sleep: time.sleep,
    })
    expect(result).toBe('attached')
    expect(probes).toBe(1)
    expect(refreshes).toBe(0)
  })

  test('a cancelled follow neither attaches nor reloads', async () => {
    const time = clock()
    let cancelled = false
    let probes = 0
    let refreshes = 0
    const result = await followNextTurn({
      attachIfLive: async () => {
        probes += 1
        cancelled = true // e.g. a stream opened again; it re-arms the follow
        return false
      },
      refreshHistory: () => {
        refreshes += 1
      },
      isCancelled: () => cancelled,
      sleep: time.sleep,
    })
    expect(result).toBe('cancelled')
    expect(probes).toBe(1)
    expect(refreshes).toBe(0)
  })

  test('the wait stays inside the window a caller tolerates', async () => {
    // `expectComplete` in the e2e spec gives a reply 15s to appear, and the
    // refresh is the last thing the follow does. A future gap must not push it
    // past that.
    const total = NEXT_TURN_PROBE_GAPS_MS.reduce((sum, gap) => sum + gap, 0)
    expect(total).toBeLessThanOrEqual(11_000)
    expect(NEXT_TURN_PROBE_GAPS_MS[0]).toBe(1500)
  })

  test('a probe that throws does not end the follow', async () => {
    const time = clock()
    let probes = 0
    const errors: unknown[] = []
    const result = await followNextTurn({
      attachIfLive: async () => {
        probes += 1
        if (probes === 1) throw new Error('probe failed')
        return true
      },
      refreshHistory: () => {},
      onError: (error) => errors.push(error),
      sleep: time.sleep,
    })
    expect(result).toBe('attached')
    expect(probes).toBe(2)
    expect(errors).toHaveLength(1)
  })
})
