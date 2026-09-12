// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { resolveAutoDowngrade } from '../gateway'

describe('Auto entitlement downgrade', () => {
  const tiers = {
    economy: 'gpt-5.4-nano',
    standard: 'claude-haiku-4-5-20251001',
    premium: 'claude-sonnet-4-6',
  } as const

  test('downgrades a premium billing rejection to standard', () => {
    expect(resolveAutoDowngrade(
      tiers.premium,
      'premium',
      tiers,
      'billing',
    )).toEqual({
      tier: 'standard',
      model: tiers.standard,
    })
  })

  test('downgrades a standard auth rejection to economy', () => {
    expect(resolveAutoDowngrade(
      tiers.standard,
      'standard',
      tiers,
      'auth',
    )).toEqual({
      tier: 'economy',
      model: tiers.economy,
    })
  })

  test('does not retry network/unknown failures or repeat the economy tier', () => {
    expect(resolveAutoDowngrade(
      tiers.premium,
      'premium',
      tiers,
      'network',
    )).toBeNull()
    expect(resolveAutoDowngrade(
      tiers.economy,
      'economy',
      tiers,
      'billing',
    )).toBeNull()
  })
})
