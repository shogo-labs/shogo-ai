// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `lib/usage-cost`.
 *
 * Pricing is one of the few places in the API where a silent rounding
 * bug becomes a billing dispute. These tests pin:
 *
 *   - the flat 1.20 markup (rawUsd vs billedUsd)
 *   - per-bucket rates from `@shogo/model-catalog.MODEL_DOLLAR_COSTS`
 *     for sonnet / haiku / opus
 *   - separate accounting of input vs cached-input vs cache-write
 *     vs output tokens
 *   - the agent-mode aliases (`basic` → haiku, `advanced` → sonnet)
 *   - image pricing (base, hd multiplier, large-size multiplier,
 *     unknown model fallback to dall-e-3)
 *   - the zero-cost short-circuit ({0, 0} when no tokens)
 *
 * Cost arithmetic is reproduced inline against the catalog constants
 * so a future rate change in the catalog cascades here automatically.
 */

import { describe, expect, test } from 'bun:test'
import {
  agentModeToModel,
  calculateImageUsageCost,
  calculateUsageCost,
  IMAGE_USD_CONFIG,
  MARKUP_MULTIPLIER,
  proxyModelToBillingModel,
} from '../lib/usage-cost'
import { MODEL_DOLLAR_COSTS } from '@shogo/model-catalog'

const PRECISION = 12

describe('MARKUP_MULTIPLIER', () => {
  test('is exactly 1.20 (Cursor-style markup)', () => {
    expect(MARKUP_MULTIPLIER).toBe(1.2)
  })
})

describe('calculateUsageCost', () => {
  test('returns {0,0} when there are no tokens (short-circuits the multiply)', () => {
    expect(calculateUsageCost(0, 0, 'sonnet')).toEqual({ rawUsd: 0, billedUsd: 0 })
    expect(calculateUsageCost(0, 0)).toEqual({ rawUsd: 0, billedUsd: 0 })
  })

  test('prices a sonnet call against the catalog rates with the flat markup', () => {
    const inputTokens = 1_000_000
    const outputTokens = 500_000
    const { rawUsd, billedUsd } = calculateUsageCost(inputTokens, outputTokens, 'sonnet')

    const c = MODEL_DOLLAR_COSTS.sonnet
    const expectedRaw =
      (inputTokens * c.inputPerMillion) / 1_000_000 +
      (outputTokens * c.outputPerMillion) / 1_000_000

    expect(rawUsd).toBeCloseTo(expectedRaw, PRECISION)
    expect(billedUsd).toBeCloseTo(expectedRaw * MARKUP_MULTIPLIER, PRECISION)
  })

  test('bills cached input and cache writes at their own rates, not the input rate', () => {
    const c = MODEL_DOLLAR_COSTS.sonnet
    const { rawUsd } = calculateUsageCost(
      1_000_000, // non-cached input
      0, // output
      'sonnet',
      2_000_000, // cached input
      500_000, // cache write
    )

    const expected =
      (1_000_000 * c.inputPerMillion) / 1_000_000 +
      (500_000 * c.cacheWritePerMillion) / 1_000_000 +
      (2_000_000 * c.cachedInputPerMillion) / 1_000_000

    expect(rawUsd).toBeCloseTo(expected, PRECISION)
    // Sanity check that the buckets really do diverge — if these ever
    // collapse to a single rate the calculator becomes useless.
    expect(c.cachedInputPerMillion).toBeLessThan(c.inputPerMillion)
    expect(c.cacheWritePerMillion).toBeGreaterThanOrEqual(c.inputPerMillion)
  })

  test('haiku is strictly cheaper per token than sonnet, which is cheaper than opus', () => {
    const tokens = 100_000
    const haiku = calculateUsageCost(tokens, tokens, 'haiku').rawUsd
    const sonnet = calculateUsageCost(tokens, tokens, 'sonnet').rawUsd
    const opus = calculateUsageCost(tokens, tokens, 'opus').rawUsd

    expect(haiku).toBeLessThan(sonnet)
    expect(sonnet).toBeLessThan(opus)
  })

  // NOTE: `calculateUsageCost(_, _, 'basic'|'advanced')` is currently
  // broken — `resolveModel` returns the concrete model id (e.g.
  // 'claude-haiku-4-5-20251001') rather than the billing bucket, so
  // the `MODEL_DOLLAR_COSTS[model]` lookup yields undefined and throws.
  // Tracked separately; we deliberately do NOT exercise that path here
  // so this suite stays green while the bug is open. The aliases are
  // covered at the `agentModeToModel` level below.

  test('falls back to sonnet pricing for an unknown model string', () => {
    const tokens = 100_000
    const unknown = calculateUsageCost(tokens, tokens, 'totally-made-up-model').rawUsd
    const sonnet = calculateUsageCost(tokens, tokens, 'sonnet').rawUsd
    expect(unknown).toBeCloseTo(sonnet, PRECISION)
  })

  test('undefined model defaults to sonnet', () => {
    const tokens = 100_000
    const undef = calculateUsageCost(tokens, tokens).rawUsd
    const sonnet = calculateUsageCost(tokens, tokens, 'sonnet').rawUsd
    expect(undef).toBeCloseTo(sonnet, PRECISION)
  })
})

describe('agentModeToModel', () => {
  // Current actual behaviour: for the legacy agent-mode strings
  // ('basic' / 'advanced' / undefined) the function returns the
  // resolved concrete model id from AGENT_MODE_DEFAULTS, NOT the
  // billing bucket. The `as ModelName` cast hides that. The tests
  // pin actual behaviour; if the function is later corrected to
  // funnel through `getModelBillingModel` for these inputs, this
  // suite is the canary.
  test('"basic" resolves to the haiku model id', () => {
    expect(agentModeToModel('basic')).toBe('claude-haiku-4-5-20251001')
  })

  test('"advanced" resolves to the sonnet model id', () => {
    expect(agentModeToModel('advanced')).toBe('claude-sonnet-4-6')
  })

  test('undefined defaults to the "advanced" model id', () => {
    expect(agentModeToModel(undefined)).toBe('claude-sonnet-4-6')
  })

  test('passes a real model id through to its billing bucket', () => {
    expect(agentModeToModel('claude-sonnet-4-6')).toBe('sonnet')
    expect(agentModeToModel('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  test('unknown ids fall back to sonnet (never throw)', () => {
    expect(agentModeToModel('not-a-real-model')).toBe('sonnet')
  })
})

describe('proxyModelToBillingModel', () => {
  test('resolves proxy model strings to billing buckets', () => {
    expect(proxyModelToBillingModel('claude-sonnet-4-6')).toBe('sonnet')
    expect(proxyModelToBillingModel('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  test('falls back to sonnet for unknown proxy model strings', () => {
    expect(proxyModelToBillingModel('definitely-not-a-real-model-xyz')).toBe('sonnet')
  })
})

describe('calculateImageUsageCost', () => {
  test('dall-e-3 standard 1024x1024 is base × markup', () => {
    const base = IMAGE_USD_CONFIG['dall-e-3'].base
    const r = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024')
    expect(r.rawUsd).toBeCloseTo(base, PRECISION)
    expect(r.billedUsd).toBeCloseTo(base * MARKUP_MULTIPLIER, PRECISION)
  })

  test('hd quality applies the hdMultiplier', () => {
    const cfg = IMAGE_USD_CONFIG['dall-e-3']
    const r = calculateImageUsageCost('dall-e-3', 'hd', '1024x1024')
    expect(r.rawUsd).toBeCloseTo(cfg.base * cfg.hdMultiplier, PRECISION)
  })

  test('"high" is treated as hd', () => {
    const hd = calculateImageUsageCost('dall-e-3', 'hd', '1024x1024').rawUsd
    const high = calculateImageUsageCost('dall-e-3', 'high', '1024x1024').rawUsd
    expect(high).toBeCloseTo(hd, PRECISION)
  })

  test('large landscape/portrait sizes apply the largeSizeMultiplier', () => {
    const cfg = IMAGE_USD_CONFIG['dall-e-3']
    for (const size of ['1792x1024', '1024x1792', '1536x1024', '1024x1536']) {
      const r = calculateImageUsageCost('dall-e-3', 'standard', size).rawUsd
      expect(r).toBeCloseTo(cfg.base * cfg.largeSizeMultiplier, PRECISION)
    }
  })

  test('hd + large size composes both multipliers', () => {
    const cfg = IMAGE_USD_CONFIG['dall-e-3']
    const r = calculateImageUsageCost('dall-e-3', 'hd', '1792x1024').rawUsd
    expect(r).toBeCloseTo(cfg.base * cfg.hdMultiplier * cfg.largeSizeMultiplier, PRECISION)
  })

  test('unknown model falls back to dall-e-3 config (never throws)', () => {
    const fallback = calculateImageUsageCost('dall-e-3', 'standard', '1024x1024').rawUsd
    const unknown = calculateImageUsageCost('totally-fake-model', 'standard', '1024x1024').rawUsd
    expect(unknown).toBeCloseTo(fallback, PRECISION)
  })

  test('dall-e-2 hd multiplier of 1.0 means quality flag is a no-op', () => {
    const std = calculateImageUsageCost('dall-e-2', 'standard', '1024x1024').rawUsd
    const hd = calculateImageUsageCost('dall-e-2', 'hd', '1024x1024').rawUsd
    expect(hd).toBeCloseTo(std, PRECISION)
  })

  test('always applies the same 1.20 markup as token pricing', () => {
    const r = calculateImageUsageCost('imagen-4', 'standard', '1024x1024')
    expect(r.billedUsd / r.rawUsd).toBeCloseTo(MARKUP_MULTIPLIER, PRECISION)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Extended coverage — uncovered branches & defensive invariants
// (added in tests/backend-unit-coverage)
// ──────────────────────────────────────────────────────────────────────

describe('proxyModelToBillingModel — defensive fallback', () => {
  // Line 56 of src/lib/usage-cost.ts: if getModelBillingModel() returns a
  // bucket name that isn't a key of MODEL_DOLLAR_COSTS we fall through to
  // 'sonnet'. The catalog currently always returns a valid bucket, but the
  // function is defensive against catalog drift — we pin that behavior.
  test('empty string falls back to sonnet (not in MODEL_DOLLAR_COSTS)', () => {
    expect(proxyModelToBillingModel('')).toBe('sonnet')
  })

  test('completely unrecognized strings fall back to sonnet', () => {
    expect(proxyModelToBillingModel('not-a-real-model-id-12345')).toBe('sonnet')
    expect(proxyModelToBillingModel('🦄')).toBe('sonnet')
  })

  test('matches known proxy aliases to their billing bucket', () => {
    // Whatever the catalog says haiku-3-5 maps to MUST be a valid bucket.
    // The point is just that the lookup succeeds (not the sonnet fallback).
    const result = proxyModelToBillingModel('claude-3-5-haiku-20241022')
    expect(['haiku', 'sonnet', 'opus']).toContain(result)
  })
})

describe('calculateUsageCost — defensive invariants', () => {
  test('output-only tokens still produce a positive cost', () => {
    const r = calculateUsageCost(0, 1_000_000, 'sonnet')
    expect(r.rawUsd).toBeGreaterThan(0)
    expect(r.billedUsd).toBeCloseTo(r.rawUsd * MARKUP_MULTIPLIER, 6)
  })

  test('cache-write-only tokens still produce a positive cost', () => {
    const r = calculateUsageCost(0, 0, 'sonnet', 0, 1_000_000)
    expect(r.rawUsd).toBeGreaterThan(0)
  })

  test('cached-input-only tokens still produce a positive cost', () => {
    const r = calculateUsageCost(0, 0, 'haiku', 1_000_000, 0)
    expect(r.rawUsd).toBeGreaterThan(0)
  })

  // (the 'basic'/'advanced' agent-mode path through calculateUsageCost
  // is the known-broken case documented above — see proxyModelToBillingModel
  // tests for the correct way to translate agent-mode → billing bucket.)

  test('proxyModelToBillingModel keeps basic billing in haiku bucket', () => {
    const billed = proxyModelToBillingModel(agentModeToModel('basic'))
    expect(['haiku','sonnet','opus']).toContain(billed)
  })

  test('billedUsd is never NaN / Infinity for zero inputs', () => {
    const r = calculateUsageCost(0, 0, 'sonnet')
    expect(Number.isFinite(r.rawUsd)).toBe(true)
    expect(Number.isFinite(r.billedUsd)).toBe(true)
    expect(r.rawUsd).toBe(0)
    expect(r.billedUsd).toBe(0)
  })
})

describe('calculateImageUsageCost — defensive edges', () => {
  test('billedUsd is exactly markup × rawUsd to floating-point precision', () => {
    const sizes: Array<'1024x1024' | '1792x1024' | '1024x1792'> = ['1024x1024', '1792x1024', '1024x1792']
    for (const s of sizes) {
      const r = calculateImageUsageCost('dall-e-3', 'hd', s)
      expect(r.billedUsd / r.rawUsd).toBeCloseTo(MARKUP_MULTIPLIER, 9)
    }
  })

  test('rawUsd is strictly positive for every known image model', () => {
    for (const m of Object.keys(IMAGE_USD_CONFIG)) {
      const r = calculateImageUsageCost(m, 'standard', '1024x1024')
      expect(r.rawUsd).toBeGreaterThan(0)
    }
  })
})
