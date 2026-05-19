// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

// Stub @shogo/model-catalog so this test does not depend on the SDK
// being built. We supply just the surface usage-cost.ts touches.
const stubCosts: Record<string, any> = {
  sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cachedInputPerMillion: 0.3 },
  haiku:  { inputPerMillion: 1, outputPerMillion: 5,  cacheWritePerMillion: 1.25, cachedInputPerMillion: 0.1 },
  opus:   { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cachedInputPerMillion: 1.5 },
}
mock.module('@shogo/model-catalog', () => ({
  MODEL_DOLLAR_COSTS: stubCosts,
  getModelTier: (_: string) => 'pro',
  getModelBillingModel: (id: string) => (id in stubCosts ? id : 'unknown-billing'),
  resolveAgentModeDefault: (mode: string) => (mode === 'advanced' ? 'sonnet' : 'haiku'),
  calculateDollarCost: () => 0,
}))

const {
  MARKUP_MULTIPLIER,
  MODEL_DOLLAR_COSTS,
  IMAGE_USD_CONFIG,
  agentModeToModel,
  proxyModelToBillingModel,
  calculateUsageCost,
  calculateImageUsageCost,
  getModelTier,
} = await import('../usage-cost')

describe('constants', () => {
  it('MARKUP_MULTIPLIER is 1.20', () => {
    expect(MARKUP_MULTIPLIER).toBe(1.2)
  })
  it('MODEL_DOLLAR_COSTS contains the sonnet default', () => {
    expect(MODEL_DOLLAR_COSTS).toHaveProperty('sonnet')
  })
})

describe('agentModeToModel', () => {
  it('returns the advanced default when no arg passed', () => {
    expect(typeof agentModeToModel()).toBe('string')
  })
  it("maps 'basic' and 'advanced' through the agent-mode resolver", () => {
    expect(typeof agentModeToModel('basic')).toBe('string')
    expect(typeof agentModeToModel('advanced')).toBe('string')
  })
  it('maps a known model id to its billing key', () => {
    // 'sonnet' is in MODEL_DOLLAR_COSTS
    expect(agentModeToModel('sonnet')).toBe('sonnet')
  })
  it('falls back to sonnet for an unknown string', () => {
    expect(agentModeToModel('not-a-model')).toBe('sonnet')
  })
})

describe('proxyModelToBillingModel', () => {
  it('maps to sonnet when unknown', () => {
    expect(proxyModelToBillingModel('mystery')).toBe('sonnet')
  })
  it('maps a known billing model identity', () => {
    expect(proxyModelToBillingModel('sonnet')).toBe('sonnet')
  })
})

describe('calculateUsageCost', () => {
  it('returns zero for zero tokens', () => {
    expect(calculateUsageCost(0, 0)).toEqual({ rawUsd: 0, billedUsd: 0 })
  })

  it('applies MARKUP_MULTIPLIER to a non-zero raw cost', () => {
    const r = calculateUsageCost(1_000_000, 1_000_000, 'sonnet')
    expect(r.rawUsd).toBeGreaterThan(0)
    expect(r.billedUsd).toBeCloseTo(r.rawUsd * MARKUP_MULTIPLIER, 8)
  })

  it('honours cached + cache-write token splits', () => {
    const cached = calculateUsageCost(0, 0, 'sonnet', 1_000_000, 0)
    const written = calculateUsageCost(0, 0, 'sonnet', 0, 1_000_000)
    const both = calculateUsageCost(0, 0, 'sonnet', 1_000_000, 1_000_000)
    expect(both.rawUsd).toBeCloseTo(cached.rawUsd + written.rawUsd, 8)
  })

  it("resolves 'basic' and 'advanced' through agentModeToModel", () => {
    const basic = calculateUsageCost(1_000_000, 1_000_000, 'basic')
    const advanced = calculateUsageCost(1_000_000, 1_000_000, 'advanced')
    expect(basic.rawUsd).toBeGreaterThan(0)
    expect(advanced.rawUsd).toBeGreaterThan(0)
  })

  it('falls back to sonnet for unknown models', () => {
    const unknown = calculateUsageCost(1_000_000, 1_000_000, 'made-up-model')
    const sonnet = calculateUsageCost(1_000_000, 1_000_000, 'sonnet')
    expect(unknown.rawUsd).toBe(sonnet.rawUsd)
  })

  it('uses sonnet when modelOrAgentMode is omitted entirely', () => {
    const def = calculateUsageCost(1_000_000, 0)
    const sonnet = calculateUsageCost(1_000_000, 0, 'sonnet')
    expect(def.rawUsd).toBe(sonnet.rawUsd)
  })
})

describe('calculateImageUsageCost', () => {
  it('returns the base cost for dall-e-3 / standard / 1024x1024', () => {
    const r = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    expect(r.rawUsd).toBeCloseTo(IMAGE_USD_CONFIG['dall-e-3'].base, 8)
    expect(r.billedUsd).toBeCloseTo(r.rawUsd * MARKUP_MULTIPLIER, 8)
  })

  it('applies the hd multiplier for quality=hd', () => {
    const base = calculateImageUsageCost('dall-e-3', 'standard')
    const hd = calculateImageUsageCost('dall-e-3', 'hd')
    expect(hd.rawUsd).toBeCloseTo(base.rawUsd * IMAGE_USD_CONFIG['dall-e-3'].hdMultiplier, 8)
  })

  it("applies the hd multiplier for quality='high'", () => {
    const base = calculateImageUsageCost('dall-e-3', 'standard')
    const high = calculateImageUsageCost('dall-e-3', 'high')
    expect(high.rawUsd).toBeCloseTo(base.rawUsd * IMAGE_USD_CONFIG['dall-e-3'].hdMultiplier, 8)
  })

  it('applies the large-size multiplier for a large size', () => {
    const square = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const wide = calculateImageUsageCost('dall-e-3', 'standard', '1792x1024')
    expect(wide.rawUsd).toBeCloseTo(
      square.rawUsd * IMAGE_USD_CONFIG['dall-e-3'].largeSizeMultiplier,
      8,
    )
  })

  it('falls back to dall-e-3 config for an unknown model', () => {
    const fallback = calculateImageUsageCost('mystery-model')
    const dalle = calculateImageUsageCost('dall-e-3')
    expect(fallback.rawUsd).toBe(dalle.rawUsd)
  })

  it('uses default args when called bare', () => {
    const r = calculateImageUsageCost('dall-e-3')
    expect(r.rawUsd).toBeCloseTo(IMAGE_USD_CONFIG['dall-e-3'].base, 8)
  })
})

describe('getModelTier re-export', () => {
  it('is callable', () => {
    expect(typeof getModelTier).toBe('function')
  })
})
