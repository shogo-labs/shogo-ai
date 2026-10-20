// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Image Generation Tests — USD pricing.
 *
 * Tests the image-generation cost calculator:
 * - Raw provider USD per image (quality + size multipliers)
 * - Flat MARKUP_MULTIPLIER applied to produce billedUsd
 * - Fallback for unknown models
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-images.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  calculateGenjutsuUsageCost,
  calculateHiggsfieldUsageCost,
  calculateImageUsageCost,
  IMAGE_USD_CONFIG,
  MARKUP_MULTIPLIER,
} from '../lib/usage-cost'
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from '@shogo/model-catalog'

describe('Image Usage Cost (USD)', () => {
  test('dall-e-3 standard 1024x1024 → ladder price, billed = raw * markup', () => {
    const { rawUsd, billedUsd } = calculateImageUsageCost(
      'dall-e-3',
      'standard',
      '1024x1024',
    )
    expect(rawUsd).toBe(IMAGE_USD_CONFIG['dall-e-3'].prices.square.medium)
    expect(billedUsd).toBeCloseTo(rawUsd * MARKUP_MULTIPLIER, 10)
  })

  test('dall-e-3 hd costs more than standard', () => {
    const standard = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const hd = calculateImageUsageCost('dall-e-3', 'hd', '1024x1024')
    expect(hd.rawUsd).toBeGreaterThan(standard.rawUsd)
    expect(hd.billedUsd).toBeGreaterThan(standard.billedUsd)
  })

  test('dall-e-3 large size costs more than 1024x1024', () => {
    const normal = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const large = calculateImageUsageCost('dall-e-3', 'standard', '1792x1024')
    expect(large.rawUsd).toBeGreaterThan(normal.rawUsd)
  })

  test('dall-e-3 hd + large size stacks quality and size', () => {
    const base = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const hdLarge = calculateImageUsageCost('dall-e-3', 'hd', '1792x1024')
    const cfg = IMAGE_USD_CONFIG['dall-e-3'].prices
    expect(hdLarge.rawUsd).toBeCloseTo(cfg.landscape.high, 10)
    expect(hdLarge.rawUsd).toBeGreaterThan(base.rawUsd)
  })

  test('gpt-image-1 standard → the medium tier, non-zero raw and billed', () => {
    const { rawUsd, billedUsd } = calculateImageUsageCost(
      'gpt-image-1',
      'standard',
      '1024x1024',
    )
    expect(rawUsd).toBeCloseTo(0.042, 8)
    expect(billedUsd).toBeCloseTo(rawUsd * MARKUP_MULTIPLIER, 10)
  })

  test('imagen-4 standard → non-zero raw and billed', () => {
    const { rawUsd, billedUsd } = calculateImageUsageCost(
      'imagen-4',
      'standard',
      '1024x1024',
    )
    expect(rawUsd).toBeGreaterThan(0)
    expect(billedUsd).toBeCloseTo(rawUsd * MARKUP_MULTIPLIER, 10)
  })

  test('imagen-4-fast ≤ imagen-4 (raw)', () => {
    const fast = calculateImageUsageCost('imagen-4-fast', 'standard', '1024x1024')
    const standard = calculateImageUsageCost('imagen-4', 'standard', '1024x1024')
    expect(fast.rawUsd).toBeLessThanOrEqual(standard.rawUsd)
  })

  test('imagen-4-ultra ≥ imagen-4 (raw)', () => {
    const ultra = calculateImageUsageCost('imagen-4-ultra', 'standard', '1024x1024')
    const standard = calculateImageUsageCost('imagen-4', 'standard', '1024x1024')
    expect(ultra.rawUsd).toBeGreaterThanOrEqual(standard.rawUsd)
  })

  test('dall-e-2 is cheaper than dall-e-3 (raw)', () => {
    const dalle2 = calculateImageUsageCost('dall-e-2', 'standard', '1024x1024')
    const dalle3 = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    expect(dalle2.rawUsd).toBeLessThan(dalle3.rawUsd)
  })

  // dall-e-3 is retired (OpenAI, 2026-09); the fallback moved to the
  // current-generation gpt-image-1 pricing profile.
  test('unknown model falls back to gpt-image-1 pricing', () => {
    const unknown = calculateImageUsageCost('unknown-model', 'standard', '1024x1024')
    const gptImage1 = calculateImageUsageCost('gpt-image-1', 'standard', '1024x1024')
    expect(unknown.rawUsd).toBe(gptImage1.rawUsd)
    expect(unknown.billedUsd).toBeCloseTo(gptImage1.billedUsd, 10)
  })

  test('billed = raw * MARKUP_MULTIPLIER for every registered model', () => {
    for (const [model, cfg] of Object.entries(IMAGE_USD_CONFIG)) {
      for (const sizeClass of ['square', 'portrait', 'landscape'] as const) {
        for (const quality of ['low', 'medium', 'high'] as const) {
          expect(cfg.prices[sizeClass][quality]).toBeGreaterThan(0)
        }
      }
      const { rawUsd, billedUsd } = calculateImageUsageCost(
        model,
        'standard',
        '1024x1024',
      )
      expect(rawUsd).toBeGreaterThan(0)
      expect(billedUsd).toBeCloseTo(rawUsd * MARKUP_MULTIPLIER, 10)
    }
  })
})

describe('fal and new catalog image pricing', () => {
  test('every non-retired catalog image model has an explicit price', () => {
    for (const entry of Object.values(IMAGE_MODEL_CATALOG)) {
      if ('retired' in entry && entry.retired) continue
      // Higgsfield prices are quoted per request by the vendor's free
      // `/estimate` and that quote is what gets billed, so an entry can be
      // legitimately unpriced here (the listing then shows `usd: null`). Where
      // we do carry a figure it must be a real one.
      if (entry.provider === 'higgsfield') {
        if (entry.usdPerRequest !== undefined) expect(entry.usdPerRequest).toBeGreaterThan(0)
        continue
      }
      expect(IMAGE_USD_CONFIG[entry.id]).toBeDefined()
    }
  })

  test('SOUL V2 fallback matches the live account: $0.004 at 720p, $0.006 at 1080p', () => {
    const standard = calculateImageUsageCost('hf-soul-v2', 'standard', '1024x1024')
    const hd = calculateImageUsageCost('hf-soul-v2', 'hd', '1024x1024')
    expect(standard.rawUsd).toBeCloseTo(0.004, 5)
    expect(hd.rawUsd).toBeCloseTo(0.006, 5)
    // The vendor's prose worked example says $0.094; the account says 23× less.
    expect(standard.rawUsd).toBeLessThan(0.01)
  })

})

describe('Higgsfield price plumbing (USD)', () => {
  test('the estimate is marked up exactly like every other media charge', () => {
    const { rawUsd, billedUsd } = calculateHiggsfieldUsageCost({ rawUsd: 0.35 })
    expect(rawUsd).toBeCloseTo(0.35, 6)
    expect(billedUsd).toBeCloseTo(0.35 * MARKUP_MULTIPLIER, 6)
  })

  test('a negative or zero estimate never credits', () => {
    expect(calculateHiggsfieldUsageCost({ rawUsd: -5 }).rawUsd).toBe(0)
    expect(calculateHiggsfieldUsageCost({ rawUsd: 0 }).billedUsd).toBe(0)
  })

  test('Genjutsu bills the rate for the resolution times the source seconds', () => {
    const entry = VIDEO_MODEL_CATALOG['hf-genjutsu-restyle'] as any
    expect(entry.usdPerSecondByResolution['720p']).toBeCloseTo(0.681, 6)
    const charge = calculateGenjutsuUsageCost(entry.usdPerSecondByResolution, '720p', 10)
    expect(charge?.rawUsd).toBeCloseTo(6.81, 6)
    expect(charge?.billedUsd).toBeCloseTo(6.81 * MARKUP_MULTIPLIER, 6)
    // An unknown tier is null, not free.
    expect(calculateGenjutsuUsageCost(entry.usdPerSecondByResolution, '8k', 10)).toBeNull()
  })
})
