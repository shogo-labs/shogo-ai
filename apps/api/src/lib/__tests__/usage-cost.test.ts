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
  getModelEntry: (id: string) => (id in stubCosts ? { id } : undefined),
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

  it('on desktop, records unknown models as unpriced instead of guessing', () => {
    const previous = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      expect(calculateUsageCost(1_000_000, 1_000_000, '4fa677d1-cloud-only', 1_000_000)).toEqual({
        rawUsd: 0,
        billedUsd: 0,
        pricingUnknown: true,
      })
      expect(calculateUsageCost(1_000_000, 1_000_000, 'sonnet').pricingUnknown).toBeUndefined()
      expect(calculateUsageCost(1_000_000, 1_000_000, 'advanced').pricingUnknown).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = previous
    }
  })

  it('uses sonnet when modelOrAgentMode is omitted entirely', () => {
    const def = calculateUsageCost(1_000_000, 0)
    const sonnet = calculateUsageCost(1_000_000, 0, 'sonnet')
    expect(def.rawUsd).toBe(sonnet.rawUsd)
  })
})

describe('calculateImageUsageCost', () => {
  it('prices dall-e-3 / standard / 1024x1024 from the ladder', () => {
    const r = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    expect(r.rawUsd).toBeCloseTo(IMAGE_USD_CONFIG['dall-e-3'].prices.square.medium, 8)
    expect(r.billedUsd).toBeCloseTo(r.rawUsd * MARKUP_MULTIPLIER, 8)
  })

  it('prices dall-e-3 hd as the high tier', () => {
    const medium = calculateImageUsageCost('dall-e-3', 'standard')
    const hd = calculateImageUsageCost('dall-e-3', 'hd')
    expect(hd.rawUsd).toBeCloseTo(0.52, 8)
    expect(hd.rawUsd).toBeGreaterThan(medium.rawUsd)
  })

  it("treats quality='high' as the same tier as hd", () => {
    const hd = calculateImageUsageCost('dall-e-3', 'hd')
    const high = calculateImageUsageCost('dall-e-3', 'high')
    expect(high.rawUsd).toBe(hd.rawUsd)
  })

  it('prices a large size from its own column', () => {
    const square = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const wide = calculateImageUsageCost('dall-e-3', 'standard', '1792x1024')
    expect(wide.rawUsd).toBeCloseTo(0.39, 8)
    expect(wide.rawUsd).toBeGreaterThan(square.rawUsd)
  })

  // dall-e-3 is retired (OpenAI, 2026-09); the fallback moved to the
  // current-generation gpt-image-1 ladder.
  it('falls back to gpt-image-1 pricing for an unknown model', () => {
    const fallback = calculateImageUsageCost('mystery-model')
    const gptImage1 = calculateImageUsageCost('gpt-image-1')
    expect(fallback.rawUsd).toBe(gptImage1.rawUsd)
  })

  it('uses default args when called bare', () => {
    const r = calculateImageUsageCost('dall-e-3')
    expect(r.rawUsd).toBeCloseTo(0.26, 8)
  })
})

describe('calculateImageUsageCost — OpenAI ladder', () => {
  // OpenAI's image-generation guide, "Calculating costs" (read 2026-10-19):
  // model × quality × size, in raw provider USD.
  const LADDER = {
    'gpt-image-1': {
      square: { low: 0.011, medium: 0.042, high: 0.167 },
      portrait: { low: 0.016, medium: 0.063, high: 0.25 },
      landscape: { low: 0.016, medium: 0.063, high: 0.25 },
    },
    'gpt-image-1.5': {
      square: { low: 0.009, medium: 0.034, high: 0.133 },
      portrait: { low: 0.013, medium: 0.05, high: 0.20 },
      landscape: { low: 0.013, medium: 0.05, high: 0.20 },
    },
    'gpt-image-2': {
      square: { low: 0.006, medium: 0.053, high: 0.211 },
      portrait: { low: 0.005, medium: 0.041, high: 0.165 },
      landscape: { low: 0.005, medium: 0.041, high: 0.165 },
    },
    'gpt-image-2.5-flare': {
      square: { low: 0.00588, medium: 0.053, high: 0.211 },
      portrait: { low: 0.005, medium: 0.041, high: 0.165 },
      landscape: { low: 0.005, medium: 0.041, high: 0.165 },
    },
  } as const
  const SIZES = {
    square: '1024x1024',
    portrait: '1024x1536',
    landscape: '1536x1024',
  } as const

  for (const [model, table] of Object.entries(LADDER)) {
    for (const sizeClass of ['square', 'portrait', 'landscape'] as const) {
      for (const quality of ['low', 'medium', 'high'] as const) {
        it(`${model} ${quality} ${sizeClass} = $${table[sizeClass][quality]}`, () => {
          const r = calculateImageUsageCost(model, quality, SIZES[sizeClass])
          expect(r.rawUsd).toBeCloseTo(table[sizeClass][quality], 8)
          expect(r.billedUsd).toBeCloseTo(table[sizeClass][quality] * 1.2, 8)
        })
      }
    }
  }

  it('bills gpt-image-1 medium 1024² at $0.042 raw / $0.0504 billed — not $0.39', () => {
    const r = calculateImageUsageCost('gpt-image-1', 'medium', '1024x1024')
    expect(r.rawUsd).toBeCloseTo(0.042, 8)
    expect(r.billedUsd).toBeCloseTo(0.0504, 8)
    expect(r.billedUsd).toBeLessThan(0.07)
  })

  it('maps standard → medium and hd → high', () => {
    for (const model of Object.keys(LADDER)) {
      const standard = calculateImageUsageCost(model, 'standard', '1024x1024')
      const medium = calculateImageUsageCost(model, 'medium', '1024x1024')
      const hd = calculateImageUsageCost(model, 'hd', '1024x1024')
      const high = calculateImageUsageCost(model, 'high', '1024x1024')
      expect(standard.rawUsd).toBe(medium.rawUsd)
      expect(hd.rawUsd).toBe(high.rawUsd)
    }
  })

  it('maps auto → medium and prices xhigh/max as high', () => {
    expect(calculateImageUsageCost('gpt-image-2', 'auto', '1024x1024').rawUsd)
      .toBe(calculateImageUsageCost('gpt-image-2', 'medium', '1024x1024').rawUsd)
    expect(calculateImageUsageCost('gpt-image-2.5-flare', 'xhigh', '1024x1024').rawUsd)
      .toBe(calculateImageUsageCost('gpt-image-2.5-flare', 'high', '1024x1024').rawUsd)
    expect(calculateImageUsageCost('gpt-image-2.5-flare', 'max', '1024x1024').rawUsd)
      .toBe(calculateImageUsageCost('gpt-image-2.5-flare', 'high', '1024x1024').rawUsd)
  })

  it('accepts the dall-e spellings for GPT image sizes', () => {
    expect(calculateImageUsageCost('gpt-image-2', 'hd', '1024x1792').rawUsd).toBeCloseTo(0.165, 8)
    expect(calculateImageUsageCost('gpt-image-2', 'hd', '1792x1024').rawUsd).toBeCloseTo(0.165, 8)
    expect(calculateImageUsageCost('gpt-image-2', 'hd', '1024x1536').rawUsd).toBeCloseTo(0.165, 8)
  })
})

describe('getModelTier re-export', () => {
  it('is callable', () => {
    expect(typeof getModelTier).toBe('function')
  })
})
