// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-481 — the per-turn Auto tier map must keep its providers.
 *
 * The API now sends `{ economy: { id, provider? } }` per tier (the cloud's
 * entries carry their provider). `parseTurnAutoTiers` used to keep only `id`,
 * so an opaque cloud id lost its routing, and when the per-turn id matched the
 * process-wide `AGENT_AUTO_TIER_MAP` entry the provider that map carried was
 * thrown away. These are the two pure functions behind that.
 */
import { describe, expect, test } from 'bun:test'
import { mergeAutoTierOverrides, parseTurnAutoTiers } from '../gateway'
import {
  autoTierIds,
  autoTierProviderHints,
  buildAutoTierMap,
  selectModelForSpawn,
} from '../model-router'

const HOSHI_ID = '4fa677d1-9f70-4c4b-9a52-5f0d1c9b6f31'

describe('parseTurnAutoTiers', () => {
  test('keeps plain-string tiers (an older API)', () => {
    expect(parseTurnAutoTiers({ economy: 'gpt-5.4-nano' })).toEqual({
      economy: { id: 'gpt-5.4-nano', provider: undefined, upstream: undefined },
    })
  })

  test('keeps the provider and upstream of an object entry', () => {
    expect(parseTurnAutoTiers({
      premium: { id: HOSHI_ID, provider: 'custom', upstream: 'hoshi' },
    })).toEqual({
      premium: { id: HOSHI_ID, provider: 'custom', upstream: 'hoshi' },
    })
  })

  test('ignores malformed tiers and returns undefined with nothing usable', () => {
    expect(parseTurnAutoTiers({ economy: {}, standard: '   ' })).toBeUndefined()
    expect(parseTurnAutoTiers(null)).toBeUndefined()
  })
})

describe('mergeAutoTierOverrides', () => {
  test('inherits the env provider when the per-turn id matches (AC6)', () => {
    const merged = mergeAutoTierOverrides(
      { premium: { id: HOSHI_ID } },
      { premium: { id: HOSHI_ID, provider: 'custom' } },
    )
    expect(merged?.premium).toEqual({ id: HOSHI_ID, provider: 'custom', upstream: undefined })
  })

  test('keeps the per-turn provider when it has one', () => {
    const merged = mergeAutoTierOverrides(
      { premium: { id: HOSHI_ID, provider: 'openrouter' } },
      { premium: { id: HOSHI_ID, provider: 'custom' } },
    )
    expect(merged?.premium?.provider).toBe('openrouter')
  })

  test('does not inherit a provider from a different id', () => {
    const merged = mergeAutoTierOverrides(
      { premium: { id: HOSHI_ID } },
      { premium: { id: 'claude-sonnet-4-6', provider: 'anthropic' } },
    )
    expect(merged?.premium).toEqual({ id: HOSHI_ID, provider: undefined, upstream: undefined })
  })

  test('tiers absent from the per-turn map keep the env entry', () => {
    const merged = mergeAutoTierOverrides(
      { standard: { id: 'gpt-5.4-mini' } },
      {
        economy: { id: 'gpt-5.4-nano', provider: 'openai' },
        premium: { id: HOSHI_ID, provider: 'custom' },
      },
    )
    expect(merged).toEqual({
      standard: { id: 'gpt-5.4-mini', provider: undefined, upstream: undefined },
      economy: { id: 'gpt-5.4-nano', provider: 'openai' },
      premium: { id: HOSHI_ID, provider: 'custom' },
    })
  })

  test('a missing map on either side leaves the other untouched', () => {
    expect(mergeAutoTierOverrides(undefined, { economy: { id: 'a' } })).toEqual({ economy: { id: 'a' } })
    expect(mergeAutoTierOverrides({ economy: { id: 'b' } }, undefined)).toEqual({ economy: { id: 'b' } })
    expect(mergeAutoTierOverrides(undefined, undefined)).toBeUndefined()
  })
})

describe('an Auto turn (AC7)', () => {
  /** The gateway's Auto block, minus the I/O around it. */
  function route(turnBody: unknown, envMap: unknown) {
    const turn = parseTurnAutoTiers(turnBody)
    const processWide = parseTurnAutoTiers(envMap)
    const override = mergeAutoTierOverrides(turn, processWide)
    const tiers = buildAutoTierMap(autoTierIds(override))
    const decision = selectModelForSpawn(
      {
        prompt: `Why does this regress, and can we refactor it? ${'context '.repeat(70)}`,
        subagentType: 'main-agent',
        toolNames: [],
        contextTokens: 8000,
      },
      { ceilingModel: tiers.premium, availableModels: tiers },
    )
    return { tiers, decision, hints: autoTierProviderHints(override) }
  }

  const CLOUD_MAP = {
    economy: { id: HOSHI_ID, provider: 'custom' },
    standard: { id: HOSHI_ID, provider: 'custom' },
    premium: { id: HOSHI_ID, provider: 'custom' },
  }

  test('a COMPLEX prompt routes to the cloud id, not Sonnet', () => {
    const { tiers, decision, hints } = route({ autoTiers: CLOUD_MAP }, CLOUD_MAP)

    expect(decision.classifiedTier).toBe('complex')
    expect(tiers.premium).toBe(HOSHI_ID)
    expect(decision.selectedModel).toBe(HOSHI_ID)
    expect(decision.selectedModel).not.toBe('claude-sonnet-4-6')
    expect(hints[HOSHI_ID]).toBe('custom')
  })

  test('the per-turn cloud id inherits its provider when only the id is sent', () => {
    // An API build that sends ids only: the process-wide map is the only place
    // the provider exists, and it must not be lost.
    const { hints } = route({ autoTiers: { economy: HOSHI_ID } }, CLOUD_MAP)
    expect(hints[HOSHI_ID]).toBe('custom')
  })
})
