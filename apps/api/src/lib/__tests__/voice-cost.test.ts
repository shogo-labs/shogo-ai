// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let subFindFirstImpl: (args: any) => Promise<any> = async () => null
let walletFindUniqueImpl: (args: any) => Promise<any> = async () => null

// usage-cost (transitively imported) pulls in @shogo/model-catalog. Stub
// it so this test doesn't depend on the SDK being built.
mock.module('@shogo/model-catalog', () => ({
  MODEL_DOLLAR_COSTS: { sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cachedInputPerMillion: 0.3 } },
  getModelTier: () => 'pro',
  getModelBillingModel: () => 'sonnet',
  resolveAgentModeDefault: () => 'sonnet',
  calculateDollarCost: () => 0,
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: (args: any) => subFindFirstImpl(args) },
    usageWallet: { findUnique: (args: any) => walletFindUniqueImpl(args) },
  },
}))

const {
  resolveVoiceRate,
  calculateVoiceMinuteCost,
  calculateVoiceNumberCost,
  resolvePlanIdForWorkspace,
  getUsdBalance,
} = await import('../voice-cost')

const ENV = process.env.SHOGO_LOCAL_MODE

beforeEach(() => {
  subFindFirstImpl = async () => null
  walletFindUniqueImpl = async () => null
  delete process.env.SHOGO_LOCAL_MODE
})
afterEach(() => {
  if (ENV === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = ENV
})

describe('resolveVoiceRate', () => {
  it('returns the flat VOICE_RAW_USD rate when no plan override exists', () => {
    expect(resolveVoiceRate('free', 'minutesInbound')).toBe(0.2)
    expect(resolveVoiceRate('pro', 'numberMonthly')).toBe(3)
  })
  it('returns the flat rate for an unknown plan family', () => {
    expect(resolveVoiceRate('mystery_xyz', 'minutesOutbound')).toBe(0.24)
  })
  it('returns the flat rate when planId is null/undefined', () => {
    expect(resolveVoiceRate(null, 'numberSetup')).toBe(2)
    expect(resolveVoiceRate(undefined, 'numberSetup')).toBe(2)
  })
})

describe('calculateVoiceMinuteCost', () => {
  it('rounds 1 second up to a 1-minute floor', () => {
    const r = calculateVoiceMinuteCost('free', 'inbound', 1)
    expect(r.billedMinutes).toBe(1)
    expect(r.rawUsd).toBeCloseTo(0.2, 8)
    expect(r.billedUsd).toBeCloseTo(0.2 * 1.2, 8)
    expect(r.rawUsdPerMinute).toBe(0.2)
    expect(r.billedUsdPerMinute).toBeCloseTo(0.24, 8)
  })
  it('rounds 61 seconds up to 2 minutes', () => {
    const r = calculateVoiceMinuteCost('free', 'outbound', 61)
    expect(r.billedMinutes).toBe(2)
  })
  it('keeps 120 seconds at exactly 2 minutes (boundary, not 3)', () => {
    const r = calculateVoiceMinuteCost('free', 'outbound', 120)
    expect(r.billedMinutes).toBe(2)
  })
  it('rounds 121 seconds up to 3 minutes', () => {
    const r = calculateVoiceMinuteCost('free', 'outbound', 121)
    expect(r.billedMinutes).toBe(3)
  })
  it('clamps negative durations to a 1-minute floor', () => {
    const r = calculateVoiceMinuteCost('free', 'inbound', -50)
    expect(r.billedMinutes).toBe(1)
  })
  it('uses the outbound rate for direction=outbound', () => {
    const inbound = calculateVoiceMinuteCost('free', 'inbound', 60)
    const outbound = calculateVoiceMinuteCost('free', 'outbound', 60)
    expect(outbound.rawUsdPerMinute).toBeGreaterThan(inbound.rawUsdPerMinute)
  })
})

describe('calculateVoiceNumberCost', () => {
  it('returns the setup rate for kind=setup', () => {
    const r = calculateVoiceNumberCost('free', 'setup')
    expect(r.rawUsd).toBe(2)
    expect(r.billedUsd).toBeCloseTo(2.4, 8)
  })
  it('returns the monthly rate for kind=monthly', () => {
    const r = calculateVoiceNumberCost('free', 'monthly')
    expect(r.rawUsd).toBe(3)
    expect(r.billedUsd).toBeCloseTo(3.6, 8)
  })
})

describe('resolvePlanIdForWorkspace', () => {
  it('returns "free" when no active subscription is found', async () => {
    subFindFirstImpl = async () => null
    expect(await resolvePlanIdForWorkspace('w')).toBe('free')
  })
  it('returns the subscription plan when found', async () => {
    subFindFirstImpl = async () => ({ planId: 'pro_monthly' })
    expect(await resolvePlanIdForWorkspace('w')).toBe('pro_monthly')
  })
  it('returns "free" when prisma throws', async () => {
    subFindFirstImpl = async () => {
      throw new Error('db down')
    }
    expect(await resolvePlanIdForWorkspace('w')).toBe('free')
  })
})

describe('getUsdBalance', () => {
  it('returns Infinity in local mode (bypass pre-flight)', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    expect(await getUsdBalance('w')).toBe(Number.POSITIVE_INFINITY)
  })
  it('returns 0 when no wallet row exists', async () => {
    walletFindUniqueImpl = async () => null
    expect(await getUsdBalance('w')).toBe(0)
  })
  it('returns daily + monthly when both present', async () => {
    walletFindUniqueImpl = async () => ({ dailyIncludedUsd: 1.5, monthlyIncludedUsd: 8.5 })
    expect(await getUsdBalance('w')).toBe(10)
  })
  it('treats null amounts as 0', async () => {
    walletFindUniqueImpl = async () => ({ dailyIncludedUsd: null, monthlyIncludedUsd: 4 })
    expect(await getUsdBalance('w')).toBe(4)
  })
  it('returns 0 when prisma throws', async () => {
    walletFindUniqueImpl = async () => {
      throw new Error('db down')
    }
    expect(await getUsdBalance('w')).toBe(0)
  })
})
