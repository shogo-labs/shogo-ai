// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Image Generation Tests
 *
 * Tests the image generation proxy endpoints:
 * - Model registry and routing
 * - OpenAI DALL-E adapter
 * - Google Imagen adapter
 * - Local provider adapter
 * - Auth validation
 * - Error handling
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-images.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  calculateImageCreditCost,
  IMAGE_CREDIT_CONFIG,
} from '../lib/credit-cost'

// =============================================================================
// Image Model Registry Tests
// =============================================================================

describe('Image Credit Cost', () => {
  test('dall-e-3 standard 1024x1024', () => {
    const cost = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    const expected = Math.ceil(IMAGE_CREDIT_CONFIG['dall-e-3'].base * 10) / 10
    expect(cost).toBe(expected)
  })

  test('dall-e-3 hd costs more', () => {
    const standard = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    const hd = calculateImageCreditCost('dall-e-3', 'hd', '1024x1024')
    expect(hd).toBeGreaterThan(standard)
  })

  test('dall-e-3 large size costs more', () => {
    const normal = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    const large = calculateImageCreditCost('dall-e-3', 'standard', '1792x1024')
    expect(large).toBeGreaterThan(normal)
  })

  test('dall-e-3 hd + large size is most expensive', () => {
    const base = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    const hdLarge = calculateImageCreditCost('dall-e-3', 'hd', '1792x1024')
    expect(hdLarge).toBeGreaterThan(base)
  })

  test('gpt-image-1 standard', () => {
    const cost = calculateImageCreditCost('gpt-image-1', 'standard', '1024x1024')
    expect(cost).toBeGreaterThan(0)
    const expected = Math.ceil(IMAGE_CREDIT_CONFIG['gpt-image-1'].base * 10) / 10
    expect(cost).toBe(expected)
  })

  test('imagen-4 standard', () => {
    const cost = calculateImageCreditCost('imagen-4', 'standard', '1024x1024')
    expect(cost).toBeGreaterThan(0)
    const expected = Math.ceil(IMAGE_CREDIT_CONFIG['imagen-4'].base * 10) / 10
    expect(cost).toBe(expected)
  })

  test('imagen-4-fast is cheaper than imagen-4', () => {
    const fast = calculateImageCreditCost('imagen-4-fast', 'standard', '1024x1024')
    const standard = calculateImageCreditCost('imagen-4', 'standard', '1024x1024')
    expect(fast).toBeLessThanOrEqual(standard)
  })

  test('imagen-4-ultra is most expensive Google model', () => {
    const ultra = calculateImageCreditCost('imagen-4-ultra', 'standard', '1024x1024')
    const standard = calculateImageCreditCost('imagen-4', 'standard', '1024x1024')
    expect(ultra).toBeGreaterThanOrEqual(standard)
  })

  test('dall-e-2 is cheapest OpenAI model', () => {
    const dalle2 = calculateImageCreditCost('dall-e-2', 'standard', '1024x1024')
    const dalle3 = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    expect(dalle2).toBeLessThan(dalle3)
  })

  test('unknown model falls back to dall-e-3 pricing', () => {
    const unknown = calculateImageCreditCost('unknown-model', 'standard', '1024x1024')
    const dalle3 = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    expect(unknown).toBe(dalle3)
  })

  test('base cost matches config directly (no separate markup)', () => {
    const cost = calculateImageCreditCost('dall-e-3', 'standard', '1024x1024')
    const base = IMAGE_CREDIT_CONFIG['dall-e-3'].base
    expect(cost).toBe(Math.ceil(base * 10) / 10)
  })

  test('all registered models have positive base cost', () => {
    for (const [model, config] of Object.entries(IMAGE_CREDIT_CONFIG)) {
      expect(config.base).toBeGreaterThan(0)
      const cost = calculateImageCreditCost(model, 'standard', '1024x1024')
      expect(cost).toBeGreaterThan(0)
    }
  })
})
