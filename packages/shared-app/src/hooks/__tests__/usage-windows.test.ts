// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the client-side window derivation to the backend `rollWindow` / snapshot
 * semantics in `apps/api/src/services/billing.service.ts`. If these drift, the
 * live usage bars will disagree with what the server actually enforces.
 */
import { describe, expect, it } from 'vitest'
import { deriveUsageWindows, resolveUsageWindows, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../usage-windows'

const NOW = Date.parse('2026-06-18T12:00:00.000Z')
const LIMITS = { fiveHourUsd: 0.2, weeklyUsd: 0.5 }

describe('deriveUsageWindows', () => {
  it('returns undefined when there is no wallet', () => {
    expect(deriveUsageWindows({ wallet: undefined, limits: LIMITS, now: NOW })).toBeUndefined()
    expect(deriveUsageWindows({ wallet: null, limits: LIMITS, now: NOW })).toBeUndefined()
  })

  it('reports utilization for an open window (used / limit)', () => {
    const fiveStart = new Date(NOW - 1 * 60 * 60 * 1000) // opened 1h ago
    const weekStart = new Date(NOW - 2 * 24 * 60 * 60 * 1000) // opened 2d ago
    const res = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: fiveStart,
        fiveHourUsedUsd: 0.1,
        weeklyWindowStart: weekStart,
        weeklyUsedUsd: 0.25,
      },
      limits: LIMITS,
      now: NOW,
    })!

    expect(res.fiveHour.usedUsd).toBe(0.1)
    expect(res.fiveHour.utilization).toBeCloseTo(0.5, 10)
    expect(res.fiveHour.limitUsd).toBe(0.2)
    expect(res.fiveHour.resetsAt).toBe(new Date(fiveStart.getTime() + FIVE_HOUR_MS).toISOString())

    expect(res.weekly.usedUsd).toBe(0.25)
    expect(res.weekly.utilization).toBeCloseTo(0.5, 10)
    expect(res.weekly.resetsAt).toBe(new Date(weekStart.getTime() + SEVEN_DAY_MS).toISOString())
  })

  it('caps utilization at 1 when usage exceeds the limit', () => {
    const res = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: new Date(NOW - 60_000),
        fiveHourUsedUsd: 0.9, // way over the 0.2 limit
        weeklyWindowStart: new Date(NOW - 60_000),
        weeklyUsedUsd: 0.5, // exactly at the 0.5 limit
      },
      limits: LIMITS,
      now: NOW,
    })!

    expect(res.fiveHour.utilization).toBe(1)
    expect(res.weekly.utilization).toBe(1)
  })

  it('lazily resets a window whose duration has fully elapsed', () => {
    const res = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: new Date(NOW - FIVE_HOUR_MS - 1), // elapsed
        fiveHourUsedUsd: 0.2,
        weeklyWindowStart: new Date(NOW - SEVEN_DAY_MS - 1), // elapsed
        weeklyUsedUsd: 0.5,
      },
      limits: LIMITS,
      now: NOW,
    })!

    // Reopened: zero used, zero utilization, and no countdown until usage starts.
    expect(res.fiveHour.usedUsd).toBe(0)
    expect(res.fiveHour.utilization).toBe(0)
    expect(res.fiveHour.resetsAt).toBeNull()
    expect(res.weekly.usedUsd).toBe(0)
    expect(res.weekly.utilization).toBe(0)
    expect(res.weekly.resetsAt).toBeNull()
  })

  it('treats a never-opened window (null start) as empty', () => {
    const res = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: null,
        fiveHourUsedUsd: 0,
        weeklyWindowStart: undefined,
        weeklyUsedUsd: 0,
      },
      limits: LIMITS,
      now: NOW,
    })!

    expect(res.fiveHour.utilization).toBe(0)
    expect(res.fiveHour.resetsAt).toBeNull()
    expect(res.weekly.utilization).toBe(0)
    expect(res.weekly.resetsAt).toBeNull()
  })

  it('reports 0 utilization for uncapped (null) limits but preserves usage/reset', () => {
    const fiveStart = new Date(NOW - 60_000)
    const res = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: fiveStart,
        fiveHourUsedUsd: 5,
        weeklyWindowStart: fiveStart,
        weeklyUsedUsd: 5,
      },
      limits: { fiveHourUsd: null, weeklyUsd: null },
      now: NOW,
    })!

    expect(res.fiveHour.limitUsd).toBeNull()
    expect(res.fiveHour.utilization).toBe(0)
    expect(res.fiveHour.usedUsd).toBe(5)
    expect(res.fiveHour.resetsAt).toBe(new Date(fiveStart.getTime() + FIVE_HOUR_MS).toISOString())
  })

  it('accepts ISO string and epoch-number window starts', () => {
    const fiveStartMs = NOW - 60 * 60 * 1000
    const fromString = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: new Date(fiveStartMs).toISOString(),
        fiveHourUsedUsd: 0.1,
        weeklyWindowStart: new Date(fiveStartMs).toISOString(),
        weeklyUsedUsd: 0.25,
      },
      limits: LIMITS,
      now: NOW,
    })!
    const fromNumber = deriveUsageWindows({
      wallet: {
        fiveHourWindowStart: fiveStartMs,
        fiveHourUsedUsd: 0.1,
        weeklyWindowStart: fiveStartMs,
        weeklyUsedUsd: 0.25,
      },
      limits: LIMITS,
      now: NOW,
    })!

    expect(fromString).toEqual(fromNumber)
    expect(fromString.fiveHour.utilization).toBeCloseTo(0.5, 10)
  })
})

describe('resolveUsageWindows', () => {
  const WEEK_LIMIT = { fiveHourUsd: 1.84, weeklyUsd: 4.6 } // business, per seat
  const snapshot = (usedUsd: number, startMs: number | null) => ({
    fiveHour: {
      kind: 'five_hour' as const,
      usedUsd,
      limitUsd: WEEK_LIMIT.fiveHourUsd,
      utilization: usedUsd / WEEK_LIMIT.fiveHourUsd,
      resetsAt: startMs == null ? null : new Date(startMs + FIVE_HOUR_MS).toISOString(),
    },
    weekly: {
      kind: 'weekly' as const,
      usedUsd,
      limitUsd: WEEK_LIMIT.weeklyUsd,
      utilization: usedUsd / WEEK_LIMIT.weeklyUsd,
      resetsAt: startMs == null ? null : new Date(startMs + SEVEN_DAY_MS).toISOString(),
    },
  })

  it('returns undefined until the server snapshot has loaded', () => {
    expect(resolveUsageWindows({ wallet: null, windows: undefined, meteredPerSeat: false })).toBeUndefined()
  })

  it('a paid plan shows the seat snapshot verbatim, never the pooled wallet', () => {
    // A seat that has not spent anything yet, while the wallet still carries
    // leftover pooled usage from before the workspace moved to per-seat meters.
    const res = resolveUsageWindows({
      wallet: { fiveHourWindowStart: NOW - 1000, fiveHourUsedUsd: 5, weeklyWindowStart: NOW - 1000, weeklyUsedUsd: 5 },
      windows: snapshot(0, null),
      meteredPerSeat: true,
      now: NOW,
    })!
    expect(res.weekly.usedUsd).toBe(0)
    expect(res.weekly.utilization).toBe(0)
    expect(res.weekly.limitUsd).toBe(4.6)
  })

  it('the free tier derives live from the wallet', () => {
    const res = resolveUsageWindows({
      wallet: {
        fiveHourWindowStart: NOW - 60 * 60 * 1000,
        fiveHourUsedUsd: 0.1,
        weeklyWindowStart: NOW - 2 * 24 * 60 * 60 * 1000,
        weeklyUsedUsd: 0.25,
      },
      windows: snapshot(0, null),
      meteredPerSeat: false,
      now: NOW,
    })!
    expect(res.fiveHour.usedUsd).toBeCloseTo(0.1, 10)
    expect(res.weekly.usedUsd).toBeCloseTo(0.25, 10)
  })

  it('keeps the server limits and never reports less usage than the snapshot', () => {
    const weekStart = NOW - 60 * 60 * 1000
    const res = resolveUsageWindows({
      // Same window start on both sides, wallet lower than the snapshot.
      wallet: { fiveHourWindowStart: weekStart, fiveHourUsedUsd: 1, weeklyWindowStart: weekStart, weeklyUsedUsd: 1 },
      windows: snapshot(3, weekStart),
      meteredPerSeat: false,
      now: NOW,
    })!
    expect(res.fiveHour.usedUsd).toBe(3)
    expect(res.fiveHour.limitUsd).toBe(WEEK_LIMIT.fiveHourUsd)
  })

  it('prefers the newer window start (a reset must not show stale usage)', () => {
    const oldStart = NOW - 9 * 24 * 60 * 60 * 1000
    const newStart = NOW - 60 * 60 * 1000
    const res = resolveUsageWindows({
      wallet: { fiveHourWindowStart: oldStart, fiveHourUsedUsd: 4, weeklyWindowStart: oldStart, weeklyUsedUsd: 4 },
      windows: snapshot(0.5, newStart),
      meteredPerSeat: false,
      now: NOW,
    })!
    expect(res.weekly.usedUsd).toBe(0.5)
    expect(res.weekly.resetsAt).toBe(new Date(newStart + SEVEN_DAY_MS).toISOString())
  })
})
