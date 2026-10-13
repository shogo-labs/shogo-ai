// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearDynamicModels,
  getDynamicModel,
  getMaxOutputTokens,
  inferProviderFromModel,
  parseDynamicModelsEnv,
  registerDynamicModels,
  rememberProviderHint,
} from '../index'

const OPUS_UUID = '8947628a-1415-4b3a-90c3-63f8a85c16b7'

afterEach(() => clearDynamicModels())

describe('inferProviderFromModel with DB-defined models', () => {
  it('falls back to custom for an unknown UUID', () => {
    expect(inferProviderFromModel(OPUS_UUID, 'anthropic')).toBe('custom')
  })

  it('resolves a registered Anthropic-backed UUID to anthropic', () => {
    registerDynamicModels([{ id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5' }])
    expect(inferProviderFromModel(OPUS_UUID, 'custom')).toBe('anthropic')
  })

  it('resolves a UUID learned from a per-chat provider hint', () => {
    rememberProviderHint(OPUS_UUID, 'anthropic')
    expect(inferProviderFromModel(OPUS_UUID)).toBe('anthropic')
  })

  it('keeps the custom route for non-Anthropic DB models', () => {
    registerDynamicModels([
      { id: '0b3c7a1e-0000-4000-8000-000000000001', provider: 'openai', apiModel: 'gpt-5.5' },
      { id: '0b3c7a1e-0000-4000-8000-000000000002', provider: 'custom', apiModel: 'mimo-v2.5' },
    ])
    expect(inferProviderFromModel('0b3c7a1e-0000-4000-8000-000000000001')).toBe('custom')
    expect(inferProviderFromModel('0b3c7a1e-0000-4000-8000-000000000002')).toBe('custom')
  })
})

describe('registerDynamicModels', () => {
  it('keeps earlier fields when a later entry only carries a provider hint', () => {
    registerDynamicModels([{ id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000 }])
    rememberProviderHint(OPUS_UUID, 'anthropic')
    expect(getDynamicModel(OPUS_UUID)).toEqual({
      id: OPUS_UUID,
      provider: 'anthropic',
      apiModel: 'claude-opus-5-5',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    })
    expect(getMaxOutputTokens(OPUS_UUID)).toBe(128_000)
  })

  it('shares state across module copies via globalThis', () => {
    registerDynamicModels([{ id: OPUS_UUID, provider: 'anthropic' }])
    const map = (globalThis as any)[Symbol.for('shogo.model-catalog.dynamic-models')] as Map<string, unknown>
    expect(map.has(OPUS_UUID)).toBe(true)
  })
})

describe('parseDynamicModelsEnv', () => {
  it('parses valid entries and drops malformed ones', () => {
    const raw = JSON.stringify([
      { id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1000000 },
      { id: 'no-provider' },
      'junk',
      { id: 'x', provider: 'custom', contextWindow: -5 },
    ])
    expect(parseDynamicModelsEnv(raw)).toEqual([
      { id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1_000_000, maxOutputTokens: undefined },
      { id: 'x', provider: 'custom', apiModel: undefined, contextWindow: undefined, maxOutputTokens: undefined },
    ])
  })

  it('returns an empty list for missing or invalid JSON', () => {
    expect(parseDynamicModelsEnv(undefined)).toEqual([])
    expect(parseDynamicModelsEnv('{not json')).toEqual([])
    expect(parseDynamicModelsEnv('{"id":"x"}')).toEqual([])
  })
})
