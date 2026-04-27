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
  calculateImageUsageCost,
  IMAGE_USD_CONFIG,
  MARKUP_MULTIPLIER,
} from '../lib/usage-cost'

describe('Image Usage Cost (USD)', () => {
  test('dall-e-3 standard 1024x1024 → raw = config base, billed = raw * markup', () => {
    const { rawUsd, billedUsd } = calculateImageUsageCost(
      'dall-e-3',
      'standard',
      '1024x1024',
    )
    expect(rawUsd).toBe(IMAGE_USD_CONFIG['dall-e-3'].base)
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

  test('dall-e-3 hd + large size stacks both multipliers', () => {
    const base = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    const hdLarge = calculateImageUsageCost('dall-e-3', 'hd', '1792x1024')
    const cfg = IMAGE_USD_CONFIG['dall-e-3']
    expect(hdLarge.rawUsd).toBeCloseTo(
      base.rawUsd * cfg.hdMultiplier * cfg.largeSizeMultiplier,
      10,
    )
  })

  test('gpt-image-1 standard → non-zero raw and billed', () => {
    const { rawUsd, billedUsd } = calculateImageUsageCost(
      'gpt-image-1',
      'standard',
      '1024x1024',
    )
    expect(rawUsd).toBeGreaterThan(0)
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

  test('unknown model falls back to dall-e-3 pricing', () => {
    const unknown = calculateImageUsageCost('unknown-model', 'standard', '1024x1024')
    const dalle3 = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    expect(unknown.rawUsd).toBe(dalle3.rawUsd)
    expect(unknown.billedUsd).toBeCloseTo(dalle3.billedUsd, 10)
  })

  test('billed = raw * MARKUP_MULTIPLIER for every registered model', () => {
    for (const [model, cfg] of Object.entries(IMAGE_USD_CONFIG)) {
      expect(cfg.base).toBeGreaterThan(0)
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
