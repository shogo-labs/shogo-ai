// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * aliases.ts v5 coverage — closes setAgentModeOverrides,
 * getAgentModeOverrides, and resolveAgentModeDefault.
 *
 * Pre-v5: LH=27/29 (93.1%), FNH=1/3 (33.3%). The existing coverage
 * only hits the module-level exports (MODEL_ALIASES, AGENT_MODE_DEFAULTS).
 * The three exported functions were never called in tests.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  setAgentModeOverrides,
  getAgentModeOverrides,
  resolveAgentModeDefault,
} from '../model-catalog/aliases'

afterEach(() => {
  // reset to empty so tests don't bleed
  setAgentModeOverrides({})
})

describe('setAgentModeOverrides / getAgentModeOverrides', () => {
  test('roundtrip: set then get returns same overrides', () => {
    setAgentModeOverrides({ basic: 'gpt-5.4-mini' })
    expect(getAgentModeOverrides()).toEqual({ basic: 'gpt-5.4-mini' })
  })
  test('clearing overrides returns empty object', () => {
    setAgentModeOverrides({ basic: 'gpt-5.4-mini' })
    setAgentModeOverrides({})
    expect(getAgentModeOverrides()).toEqual({})
  })
  test('getAgentModeOverrides returns a copy, not the internal ref', () => {
    setAgentModeOverrides({ basic: 'gpt-5.4-mini' })
    const copy = getAgentModeOverrides()
    copy.basic = 'other' as never
    expect(getAgentModeOverrides().basic).toBe('gpt-5.4-mini')
  })
})

describe('resolveAgentModeDefault', () => {
  test('returns default when no override set', () => {
    expect(resolveAgentModeDefault('basic')).toBe('claude-haiku-4-5-20251001')
    expect(resolveAgentModeDefault('advanced')).toBe('claude-sonnet-4-6')
  })
  test('returns override when set', () => {
    setAgentModeOverrides({ basic: 'gpt-5.4-mini' })
    expect(resolveAgentModeDefault('basic')).toBe('gpt-5.4-mini')
  })
  test('falls back to default when override is for different mode', () => {
    setAgentModeOverrides({ advanced: 'gpt-5.4-mini' })
    expect(resolveAgentModeDefault('basic')).toBe('claude-haiku-4-5-20251001')
  })
})
