// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/voice-cost.ts — targets the still-uncovered
 * branches the main `voice-cost.test.ts` skips:
 *
 *   - `resolvePlanIdForWorkspace` returning 'free' when the prisma
 *     query throws (catch arm).
 *   - `getUsdBalance` short-circuits to Infinity in
 *     `SHOGO_LOCAL_MODE=true`.
 *   - `getUsdBalance` returns 0 when no wallet row exists.
 *   - `getUsdBalance` returns 0 when the prisma read throws (catch).
 *   - `getUsdBalance` treats null daily/monthly columns as 0.
 *   - `getUsdBalance` sums non-null daily + monthly columns.
 *   - `calculateVoiceMinuteCost` rounds-up boundaries (0s→1min,
 *     59s→1min, 60s→1min, 61s→2min, 120s→2min, 121s→3min) and clamps
 *     negative `durationSeconds`.
 *
 *   bun test apps/api/src/__tests__/voice-cost-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let subscriptionFindFirst: (args: any) => Promise<any> = async () => null
let walletFindUnique: (args: any) => Promise<any> = async () => null

mock.module('../lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: (args: any) => subscriptionFindFirst(args) },
    usageWallet: { findUnique: (args: any) => walletFindUnique(args) },
  },
}))

const {
  resolveVoiceRate,
  calculateVoiceMinuteCost,
  calculateVoiceNumberCost,
  resolvePlanIdForWorkspace,
  getUsdBalance,
} = await import('../lib/voice-cost')

const SAVED_LOCAL = process.env.SHOGO_LOCAL_MODE
beforeEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
  subscriptionFindFirst = async () => null
  walletFindUnique = async () => null
})
afterEach(() => {
  if (SAVED_LOCAL === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = SAVED_LOCAL
})

describe('resolveVoiceRate — fallback chain', () => {
  test('falls back to the flat rate when planId is null/undefined', () => {
    const flat = resolveVoiceRate(null, 'minutesInbound')
    expect(flat).toBeGreaterThan(0)
    expect(resolveVoiceRate(undefined, 'minutesInbound')).toBe(flat)
  })

  test('falls back to the flat rate when planId family has no override for that key', () => {
    expect(resolveVoiceRate('unknown_xyz_999', 'minutesInbound')).toBeGreaterThan(0)
  })

  test('respects the planId family prefix (everything before the first underscore)', () => {
    const a = resolveVoiceRate('pro_monthly', 'minutesInbound')
    const b = resolveVoiceRate('pro_yearly', 'minutesInbound')
    expect(a).toBe(b)
  })
})

describe('resolvePlanIdForWorkspace', () => {
  test('returns "free" when no active/trialing subscription exists', async () => {
    subscriptionFindFirst = async () => null
    expect(await resolvePlanIdForWorkspace('ws-1')).toBe('free')
  })

  test('returns the planId of the active subscription', async () => {
    subscriptionFindFirst = async () => ({ planId: 'pro_monthly' })
    expect(await resolvePlanIdForWorkspace('ws-1')).toBe('pro_monthly')
  })

  test('returns "free" when the prisma query throws', async () => {
    subscriptionFindFirst = async () => { throw new Error('db down') }
    expect(await resolvePlanIdForWorkspace('ws-1')).toBe('free')
  })

  test('queries with the correct status filter', async () => {
    let captured: any = null
    subscriptionFindFirst = async (args) => { captured = args; return null }
    await resolvePlanIdForWorkspace('ws-99')
    expect(captured.where.workspaceId).toBe('ws-99')
    expect(captured.where.status.in).toEqual(['active', 'trialing'])
  })
})

describe('getUsdBalance', () => {
  test('returns Infinity in SHOGO_LOCAL_MODE without consulting prisma', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    let called = false
    walletFindUnique = async () => { called = true; return null }
    expect(await getUsdBalance('ws-1')).toBe(Number.POSITIVE_INFINITY)
    expect(called).toBe(false)
  })

  test('returns 0 when no wallet row exists', async () => {
    walletFindUnique = async () => null
    expect(await getUsdBalance('ws-1')).toBe(0)
  })

  test('returns 0 when the prisma read throws', async () => {
    walletFindUnique = async () => { throw new Error('db down') }
    expect(await getUsdBalance('ws-1')).toBe(0)
  })

  test('sums daily + monthly USD', async () => {
    walletFindUnique = async () => ({ dailyIncludedUsd: 1.25, monthlyIncludedUsd: 4.75 })
    expect(await getUsdBalance('ws-1')).toBeCloseTo(6, 6)
  })

  test('treats null daily / monthly as 0', async () => {
    walletFindUnique = async () => ({ dailyIncludedUsd: null, monthlyIncludedUsd: 3.5 })
    expect(await getUsdBalance('ws-1')).toBeCloseTo(3.5, 6)
    walletFindUnique = async () => ({ dailyIncludedUsd: 2.5, monthlyIncludedUsd: null })
    expect(await getUsdBalance('ws-1')).toBeCloseTo(2.5, 6)
    walletFindUnique = async () => ({ dailyIncludedUsd: null, monthlyIncludedUsd: null })
    expect(await getUsdBalance('ws-1')).toBe(0)
  })

  test('SHOGO_LOCAL_MODE other than "true" is treated as off', async () => {
    process.env.SHOGO_LOCAL_MODE = 'false'
    walletFindUnique = async () => ({ dailyIncludedUsd: 1, monthlyIncludedUsd: 2 })
    expect(await getUsdBalance('ws-1')).toBe(3)
    process.env.SHOGO_LOCAL_MODE = '1'
    expect(await getUsdBalance('ws-1')).toBe(3)
  })
})

describe('calculateVoiceMinuteCost — Math.ceil rounding edges', () => {
  function billedMinutes(seconds: number) {
    return calculateVoiceMinuteCost(null, 'outbound', seconds).billedMinutes
  }

  test('0s → 1min (EL always connects, minimum 1)', () => {
    expect(billedMinutes(0)).toBe(1)
  })
  test('1s → 1min', () => { expect(billedMinutes(1)).toBe(1) })
  test('59s → 1min', () => { expect(billedMinutes(59)).toBe(1) })
  test('60s → 1min', () => { expect(billedMinutes(60)).toBe(1) })
  test('61s → 2min', () => { expect(billedMinutes(61)).toBe(2) })
  test('120s → 2min', () => { expect(billedMinutes(120)).toBe(2) })
  test('121s → 3min', () => { expect(billedMinutes(121)).toBe(3) })

  test('negative durationSeconds clamps to 0 → 1min', () => {
    expect(billedMinutes(-50)).toBe(1)
  })

  test('fractional durationSeconds are floored (Math.floor) before rounding', () => {
    // 60.9s -> floor=60 -> ceil(60/60)=1
    expect(billedMinutes(60.9)).toBe(1)
    // 60.0001s -> floor=60 -> 1
    expect(billedMinutes(60.0001)).toBe(1)
  })

  test('inbound vs outbound use different rate keys', () => {
    const o = calculateVoiceMinuteCost('pro_monthly', 'outbound', 60)
    const i = calculateVoiceMinuteCost('pro_monthly', 'inbound', 60)
    expect(o.rawUsdPerMinute).toBeGreaterThan(0)
    expect(i.rawUsdPerMinute).toBeGreaterThan(0)
    // billedUsdPerMinute = rawUsdPerMinute * MARKUP
    expect(o.billedUsdPerMinute).toBeGreaterThan(o.rawUsdPerMinute)
  })
})

describe('calculateVoiceNumberCost', () => {
  test('returns rawUsd and billedUsd for setup', () => {
    const { rawUsd, billedUsd } = calculateVoiceNumberCost(null, 'setup')
    expect(rawUsd).toBeGreaterThan(0)
    expect(billedUsd).toBeGreaterThan(rawUsd)
  })
  test('returns rawUsd and billedUsd for monthly', () => {
    const { rawUsd, billedUsd } = calculateVoiceNumberCost(null, 'monthly')
    expect(rawUsd).toBeGreaterThan(0)
    expect(billedUsd).toBeGreaterThan(rawUsd)
  })
})
