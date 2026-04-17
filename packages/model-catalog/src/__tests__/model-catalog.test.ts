// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect } from 'bun:test'
import {
  isAutoModel,
  getModelTier,
  getModelDisplayName,
  getModelShortDisplayName,
  getModelEntry,
  inferProviderFromModel,
  resolveModelId,
  getModelFamily,
  AUTO_MODEL_ID,
  AGENT_MODE_DEFAULTS,
} from '../index'

// ---------------------------------------------------------------------------
// isAutoModel
// ---------------------------------------------------------------------------

describe('isAutoModel', () => {
  test('returns true for "auto"', () => {
    expect(isAutoModel('auto')).toBe(true)
  })

  test('returns true for AUTO_MODEL_ID constant', () => {
    expect(isAutoModel(AUTO_MODEL_ID)).toBe(true)
  })

  test('returns false for regular model IDs', () => {
    expect(isAutoModel('claude-sonnet-4-6')).toBe(false)
    expect(isAutoModel('gpt-5.4-nano')).toBe(false)
    expect(isAutoModel('basic')).toBe(false)
    expect(isAutoModel('advanced')).toBe(false)
    expect(isAutoModel('')).toBe(false)
  })

  test('is case-sensitive', () => {
    expect(isAutoModel('Auto')).toBe(false)
    expect(isAutoModel('AUTO')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getModelTier
// ---------------------------------------------------------------------------

describe('getModelTier', () => {
  test('auto model returns economy tier', () => {
    expect(getModelTier('auto')).toBe('economy')
  })

  test('haiku models return economy tier', () => {
    expect(getModelTier('claude-haiku-4-5-20251001')).toBe('economy')
  })

  test('sonnet models return standard tier', () => {
    expect(getModelTier('claude-sonnet-4-6')).toBe('standard')
  })

  test('nano models return economy tier', () => {
    expect(getModelTier('gpt-5.4-nano')).toBe('economy')
  })

  test('unknown models default to standard', () => {
    expect(getModelTier('totally-unknown-model')).toBe('standard')
  })

  test('heuristic fallback for unknown models with keywords', () => {
    expect(getModelTier('some-haiku-variant')).toBe('economy')
    expect(getModelTier('some-nano-variant')).toBe('economy')
    expect(getModelTier('some-opus-variant')).toBe('premium')
  })
})

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

describe('getModelDisplayName', () => {
  test('auto model returns "Auto"', () => {
    expect(getModelDisplayName('auto')).toBe('Auto')
  })

  test('known model returns display name', () => {
    const name = getModelDisplayName('claude-sonnet-4-6')
    expect(name).toContain('Sonnet')
  })

  test('empty string returns "Unknown"', () => {
    expect(getModelDisplayName('')).toBe('Unknown')
  })

  test('unknown model returns raw ID', () => {
    expect(getModelDisplayName('my-model')).toBe('my-model')
  })

  test('very long unknown ID is truncated', () => {
    const longId = 'a'.repeat(30)
    const display = getModelDisplayName(longId)
    expect(display.length).toBeLessThanOrEqual(23) // 20 + '...'
  })
})

describe('getModelShortDisplayName', () => {
  test('auto model returns "Auto"', () => {
    expect(getModelShortDisplayName('auto')).toBe('Auto')
  })

  test('known model returns short display name', () => {
    const name = getModelShortDisplayName('claude-sonnet-4-6')
    expect(name.length).toBeLessThan(getModelDisplayName('claude-sonnet-4-6').length + 1)
  })

  test('empty string returns "Unknown"', () => {
    expect(getModelShortDisplayName('')).toBe('Unknown')
  })
})

// ---------------------------------------------------------------------------
// inferProviderFromModel
// ---------------------------------------------------------------------------

describe('inferProviderFromModel', () => {
  test('claude models → anthropic', () => {
    expect(inferProviderFromModel('claude-sonnet-4-6')).toBe('anthropic')
    expect(inferProviderFromModel('claude-haiku-4-5-20251001')).toBe('anthropic')
  })

  test('gpt models → openai', () => {
    expect(inferProviderFromModel('gpt-5.4-nano')).toBe('openai')
    expect(inferProviderFromModel('gpt-5.4-mini')).toBe('openai')
  })

  test('basic/advanced → anthropic', () => {
    expect(inferProviderFromModel('basic')).toBe('anthropic')
    expect(inferProviderFromModel('advanced')).toBe('anthropic')
  })

  test('unknown model uses fallback', () => {
    expect(inferProviderFromModel('unknown-model', 'google')).toBe('google')
  })

  test('default fallback is anthropic', () => {
    expect(inferProviderFromModel('unknown-model')).toBe('anthropic')
  })

  test('gemini models → google', () => {
    expect(inferProviderFromModel('gemini-pro')).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

describe('resolveModelId', () => {
  test('canonical IDs pass through unchanged', () => {
    expect(resolveModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('basic resolves to a concrete model', () => {
    const resolved = resolveModelId('basic')
    expect(resolved).not.toBe('basic')
    expect(resolved.length).toBeGreaterThan(0)
  })

  test('advanced resolves to a concrete model', () => {
    const resolved = resolveModelId('advanced')
    expect(resolved).not.toBe('advanced')
    expect(resolved.length).toBeGreaterThan(0)
  })

  test('unknown IDs pass through unchanged', () => {
    expect(resolveModelId('unknown-xyz')).toBe('unknown-xyz')
  })
})

// ---------------------------------------------------------------------------
// getModelEntry
// ---------------------------------------------------------------------------

describe('getModelEntry', () => {
  test('known model returns entry with required fields', () => {
    const entry = getModelEntry('claude-sonnet-4-6')
    expect(entry).toBeDefined()
    expect(entry!.provider).toBe('anthropic')
    expect(entry!.displayName).toBeTruthy()
    expect(entry!.tier).toBeTruthy()
  })

  test('gpt-5.4-nano is in the catalog', () => {
    const entry = getModelEntry('gpt-5.4-nano')
    expect(entry).toBeDefined()
    expect(entry!.provider).toBe('openai')
  })

  test('unknown model returns undefined', () => {
    expect(getModelEntry('not-a-real-model')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AGENT_MODE_DEFAULTS
// ---------------------------------------------------------------------------

describe('AGENT_MODE_DEFAULTS', () => {
  test('basic and advanced are defined', () => {
    expect(AGENT_MODE_DEFAULTS.basic).toBeTruthy()
    expect(AGENT_MODE_DEFAULTS.advanced).toBeTruthy()
  })

  test('basic and advanced resolve to different models', () => {
    const basicResolved = resolveModelId(AGENT_MODE_DEFAULTS.basic)
    const advancedResolved = resolveModelId(AGENT_MODE_DEFAULTS.advanced)
    expect(basicResolved).not.toBe(advancedResolved)
  })
})

// ---------------------------------------------------------------------------
// getModelFamily
// ---------------------------------------------------------------------------

describe('getModelFamily', () => {
  test('sonnet models return sonnet family', () => {
    expect(getModelFamily('claude-sonnet-4-6')).toBe('sonnet')
  })

  test('haiku models return haiku family', () => {
    expect(getModelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  test('gpt models return gpt family', () => {
    expect(getModelFamily('gpt-5.4-nano')).toBe('gpt')
  })
})
