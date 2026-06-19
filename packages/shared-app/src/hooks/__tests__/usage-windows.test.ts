// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the client-side window derivation to the backend `rollWindow` / snapshot
 * semantics in `apps/api/src/services/billing.service.ts`. If these drift, the
 * live usage bars will disagree with what the server actually enforces.
 */
import { describe, expect, it } from 'vitest'
import { deriveUsageWindows, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../usage-windows'

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
