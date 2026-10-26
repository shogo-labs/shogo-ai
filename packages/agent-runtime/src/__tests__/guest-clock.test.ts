// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `POST /pool/rehydrate` clock step (guest-clock.ts).
 *
 * A metal guest resumed from a snapshot can come back with its wall clock
 * frozen at snapshot time; the host sends its clock as `hostNowMs` and the
 * guest corrects itself before restarting the sidecars. These are the three
 * behaviours the route depends on: correct a real skew, leave a small one
 * alone, and do nothing at all when the host sent nothing (AC3).
 */

import { describe, expect, test } from 'bun:test'
import { CLOCK_SKEW_TOLERANCE_MS, syncGuestClock } from '../guest-clock'

const HOST_NOW = 1_790_000_000_000

function deps(guestNow: number) {
  const set: number[] = []
  return {
    set,
    d: {
      now: () => guestNow,
      clockSetBlockedReason: () => null,
      setWallClock: async (atMs: number) => {
        set.push(atMs)
        return null
      },
    },
  }
}

describe('syncGuestClock', () => {
  test('corrects a guest more than the tolerance behind the host', async () => {
    // The staging incident: 4h40m behind after a long suspend.
    const { d, set } = deps(HOST_NOW - 4 * 3600_000 - 40 * 60_000)
    const r = await syncGuestClock(HOST_NOW, d)
    expect(r?.corrected).toBe(true)
    expect(r?.skewMs).toBe(-(4 * 3600_000 + 40 * 60_000))
    expect(r?.error).toBeUndefined()
    expect(set).toEqual([HOST_NOW])
  })

  test('corrects a guest running ahead of the host too', async () => {
    const { d, set } = deps(HOST_NOW + 60_000)
    const r = await syncGuestClock(HOST_NOW, d)
    expect(r?.corrected).toBe(true)
    expect(set).toEqual([HOST_NOW])
  })

  test('leaves a skew inside the tolerance alone', async () => {
    const { d, set } = deps(HOST_NOW - (CLOCK_SKEW_TOLERANCE_MS - 1))
    const r = await syncGuestClock(HOST_NOW, d)
    expect(r).toEqual({ skewMs: -(CLOCK_SKEW_TOLERANCE_MS - 1), corrected: false })
    expect(set).toEqual([])
  })

  test('does nothing when the host sent no hostNowMs', async () => {
    // What `body?.hostNowMs` can hand the route: an old host sends nothing.
    for (const value of [undefined, null, {}, '', 'now', NaN, 0, -1, Infinity]) {
      const { d, set } = deps(HOST_NOW - 4 * 3600_000)
      expect(await syncGuestClock(value, d)).toBeNull()
      expect(set).toEqual([])
    }
  })

  test('reports why it could not set the clock instead of silently skipping', async () => {
    const { d, set } = deps(HOST_NOW - 4 * 3600_000)
    const r = await syncGuestClock(HOST_NOW, {
      ...d,
      clockSetBlockedReason: () => 'cannot set the clock as uid 1001 (needs root or CAP_SYS_TIME)',
    })
    expect(r?.corrected).toBe(false)
    expect(r?.error).toMatch(/uid 1001/)
    expect(set).toEqual([])
  })

  test('reports a failed `date -s`', async () => {
    const { d } = deps(HOST_NOW - 4 * 3600_000)
    const r = await syncGuestClock(HOST_NOW, {
      ...d,
      setWallClock: async () => 'date -s exited 1: date: cannot set date: Operation not permitted',
    })
    expect(r?.corrected).toBe(false)
    expect(r?.error).toMatch(/Operation not permitted/)
  })

  test('reports the residual skew after correcting', async () => {
    const { d } = deps(HOST_NOW - 5_000)
    let t = HOST_NOW - 5_000
    const r = await syncGuestClock(HOST_NOW, {
      ...d,
      now: () => t,
      setWallClock: async (atMs: number) => {
        t = atMs
        return null
      },
    })
    expect(r?.corrected).toBe(true)
    expect(r?.residualMs).toBe(0)
  })
})
