// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import {
  isAutoModel,
  resolveModelId,
  getModelEntry,
  getImageModelEntry,
  getModelDisplayName,
  getModelShortDisplayName,
  inferProviderFromModel,
  getModelTier,
  getModelBillingModel,
  getMaxOutputTokens,
  getModelFamily,
  calculateDollarCost,
  getAvailableModels,
  getModelsByProvider,
  getSubagentOrchestrationReliability,
  MODEL_DOLLAR_COSTS,
} from '../model-catalog/helpers.js'
import { AUTO_MODEL_ID, MODEL_CATALOG, IMAGE_MODEL_CATALOG } from '../model-catalog/models.js'
import { MODEL_ALIASES, resolveAgentModeDefault } from '../model-catalog/aliases.js'

const FIRST_CANONICAL = Object.keys(MODEL_CATALOG)[0]
const FIRST_ENTRY = MODEL_CATALOG[FIRST_CANONICAL as keyof typeof MODEL_CATALOG]
const FIRST_IMAGE_KEY = Object.keys(IMAGE_MODEL_CATALOG)[0]
const FIRST_IMAGE_ENTRY = (IMAGE_MODEL_CATALOG as any)[FIRST_IMAGE_KEY]
const FIRST_ALIAS = Object.keys(MODEL_ALIASES)[0]

describe('isAutoModel', () => {
  it('returns true for AUTO_MODEL_ID', () => {
    expect(isAutoModel(AUTO_MODEL_ID)).toBe(true)
  })
  it('returns false for everything else', () => {
    expect(isAutoModel('claude-sonnet-4-6')).toBe(false)
    expect(isAutoModel('')).toBe(false)
  })
})

describe('resolveModelId', () => {
  it('returns canonical IDs unchanged', () => {
    expect(resolveModelId(FIRST_CANONICAL)).toBe(FIRST_CANONICAL)
  })
  it('resolves an alias to its canonical', () => {
    expect(resolveModelId(FIRST_ALIAS)).toBe(MODEL_ALIASES[FIRST_ALIAS])
  })
  it('resolves "basic" agent mode', () => {
    expect(resolveModelId('basic')).toBe(resolveAgentModeDefault('basic' as any))
  })
  it('resolves "advanced" agent mode', () => {
    expect(resolveModelId('advanced')).toBe(resolveAgentModeDefault('advanced' as any))
  })
  it('returns unknown IDs unchanged', () => {
    expect(resolveModelId('totally-unknown-model-xyz')).toBe('totally-unknown-model-xyz')
  })
})

describe('getModelEntry / getImageModelEntry', () => {
  it('returns the entry for a canonical model', () => {
    expect(getModelEntry(FIRST_CANONICAL)).toEqual(FIRST_ENTRY as any)
  })
  it('resolves through aliases', () => {
    expect(getModelEntry(FIRST_ALIAS)).toEqual(MODEL_CATALOG[MODEL_ALIASES[FIRST_ALIAS] as keyof typeof MODEL_CATALOG] as any)
  })
  it('returns undefined for unknown IDs', () => {
    expect(getModelEntry('no-such-model-xyz')).toBeUndefined()
  })
  it('returns image entry for a direct key', () => {
    expect(getImageModelEntry(FIRST_IMAGE_KEY)).toEqual(FIRST_IMAGE_ENTRY)
  })
  it('falls back to prefix-matching the catalog key', () => {
    const shortPrefix = FIRST_IMAGE_KEY.slice(0, 2)
    const result = getImageModelEntry(shortPrefix)
    expect(result).toBeDefined()
  })
  it('falls back to prefix-matching the apiModel field', () => {
    const apiPrefix = FIRST_IMAGE_ENTRY.apiModel.slice(0, 3)
    const result = getImageModelEntry(apiPrefix)
    expect(result).toBeDefined()
  })
  it('returns undefined for an image ID with no match', () => {
    expect(getImageModelEntry('zzz-no-match-image')).toBeUndefined()
  })
})

describe('getModelDisplayName / getModelShortDisplayName', () => {
  it('returns "Unknown" for empty', () => {
    expect(getModelDisplayName('')).toBe('Unknown')
    expect(getModelShortDisplayName('')).toBe('Unknown')
  })
  it('returns "Auto" for AUTO_MODEL_ID', () => {
    expect(getModelDisplayName(AUTO_MODEL_ID)).toBe('Auto')
    expect(getModelShortDisplayName(AUTO_MODEL_ID)).toBe('Auto')
  })
  it('returns catalog displayName for known model', () => {
    expect(getModelDisplayName(FIRST_CANONICAL)).toBe(FIRST_ENTRY.displayName)
    expect(getModelShortDisplayName(FIRST_CANONICAL)).toBe(FIRST_ENTRY.shortDisplayName)
  })
  it('passes short unknown IDs through unchanged', () => {
    expect(getModelDisplayName('foo-bar')).toBe('foo-bar')
    expect(getModelShortDisplayName('foo-bar')).toBe('foo-bar')
  })
  it('truncates long unknown IDs to 20 chars + ...', () => {
    const longId = 'a'.repeat(40)
    expect(getModelDisplayName(longId)).toBe('a'.repeat(20) + '...')
    expect(getModelShortDisplayName(longId)).toBe('a'.repeat(20) + '...')
  })
})

describe('inferProviderFromModel', () => {
  it('maps basic and advanced to anthropic', () => {
    expect(inferProviderFromModel('basic')).toBe('anthropic')
    expect(inferProviderFromModel('advanced')).toBe('anthropic')
  })
  it('uses catalog provider when known', () => {
    expect(inferProviderFromModel(FIRST_CANONICAL)).toBe(FIRST_ENTRY.provider)
  })
  it('infers openai from "gpt" prefix', () => {
    expect(inferProviderFromModel('gpt-future-9')).toBe('openai')
  })
  it('infers anthropic from "claude" prefix', () => {
    expect(inferProviderFromModel('claude-unknown-xyz')).toBe('anthropic')
  })
  it('infers google from "gemini" prefix', () => {
    expect(inferProviderFromModel('gemini-2.5-pro')).toBe('google')
  })
  it('falls back to custom fallback for unknowns', () => {
    expect(inferProviderFromModel('mistral-xl', 'other')).toBe('other')
    expect(inferProviderFromModel('mistral-xl')).toBe('anthropic')
  })
})

describe('getModelTier', () => {
  it('returns economy for AUTO', () => {
    expect(getModelTier(AUTO_MODEL_ID)).toBe('economy')
  })
  it('uses catalog tier when known', () => {
    expect(getModelTier(FIRST_CANONICAL)).toBe(FIRST_ENTRY.tier)
  })
  it('infers premium from "opus"', () => {
    expect(getModelTier('claude-opus-xyz-unknown')).toBe('premium')
  })
  it('infers economy from "haiku"', () => {
    expect(getModelTier('claude-haiku-xyz-unknown')).toBe('economy')
  })
  it('infers economy from "nano"', () => {
    expect(getModelTier('gpt-nano-xyz')).toBe('economy')
  })
  it('infers economy from "mini"', () => {
    expect(getModelTier('gpt-mini-xyz')).toBe('economy')
  })
  it('defaults unknowns to standard', () => {
    expect(getModelTier('mystery-model')).toBe('standard')
  })
})

describe('getModelBillingModel', () => {
  it('uses catalog billingModel when known', () => {
    expect(getModelBillingModel(FIRST_CANONICAL)).toBe(FIRST_ENTRY.billingModel)
  })
  it('defaults unknowns to sonnet', () => {
    expect(getModelBillingModel('mystery')).toBe('sonnet')
  })
})

describe('getMaxOutputTokens', () => {
  it('uses catalog when known', () => {
    expect(getMaxOutputTokens(FIRST_CANONICAL)).toBe(FIRST_ENTRY.maxOutputTokens)
  })
  it('defaults to 64000 for unknowns', () => {
    expect(getMaxOutputTokens('mystery')).toBe(64_000)
  })
})

describe('getModelFamily', () => {
  it('uses catalog when known', () => {
    expect(getModelFamily(FIRST_CANONICAL)).toBe(FIRST_ENTRY.family)
  })
  it('infers opus from "opus"', () => {
    expect(getModelFamily('claude-opus-unknown')).toBe('opus')
  })
  it('infers sonnet from "sonnet"', () => {
    expect(getModelFamily('claude-sonnet-unknown')).toBe('sonnet')
  })
  it('infers haiku from "haiku"', () => {
    expect(getModelFamily('claude-haiku-unknown')).toBe('haiku')
  })
  it('infers gpt from "gpt" prefix', () => {
    expect(getModelFamily('gpt-unknown-12')).toBe('gpt')
  })
  it('falls back to "other" for unknowns', () => {
    expect(getModelFamily('mystery')).toBe('other')
  })
})

describe('calculateDollarCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(calculateDollarCost('claude-sonnet-4-6', 0, 0)).toBe(0)
  })
  it('computes the sum of all four buckets', () => {
    const costs = MODEL_DOLLAR_COSTS.sonnet
    const r = calculateDollarCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 1_000_000, 1_000_000)
    expect(r).toBeCloseTo(
      costs.inputPerMillion + costs.outputPerMillion +
      costs.cachedInputPerMillion + costs.cacheWritePerMillion,
      6,
    )
  })
  it('defaults to sonnet when modelOrAgentMode is undefined', () => {
    const sonnet = MODEL_DOLLAR_COSTS.sonnet
    expect(calculateDollarCost(undefined, 1_000_000, 0)).toBeCloseTo(sonnet.inputPerMillion, 6)
  })
  it('uses haiku pricing when model is haiku-billing', () => {
    const haikuModel = Object.entries(MODEL_CATALOG).find(([_, e]) => e.billingModel === 'haiku')?.[0]
    if (!haikuModel) return
    expect(calculateDollarCost(haikuModel, 1_000_000, 0)).toBeCloseTo(MODEL_DOLLAR_COSTS.haiku.inputPerMillion, 6)
  })
})

describe('getAvailableModels', () => {
  it('defaults to current-generation models', () => {
    const r = getAvailableModels()
    expect(r.length).toBeGreaterThan(0)
    expect(r.every(e => e.generation === 'current')).toBe(true)
  })
  it('filters by provider', () => {
    const r = getAvailableModels({ provider: 'anthropic' as any })
    expect(r.every(e => e.provider === 'anthropic')).toBe(true)
  })
  it('filters by tier', () => {
    const r = getAvailableModels({ tier: 'standard' as any })
    expect(r.every(e => e.tier === 'standard')).toBe(true)
  })
  it('returns empty array when no models match all filters', () => {
    expect(getAvailableModels({ provider: 'zz' as any })).toEqual([])
  })
})

describe('getModelsByProvider', () => {
  it('groups by provider label', () => {
    const groups = getModelsByProvider()
    expect(groups.length).toBeGreaterThan(0)
    const labels = groups.map(g => g.label)
    expect(labels.some(l => l === 'Anthropic' || l === 'OpenAI')).toBe(true)
    expect(groups.every(g => g.models.length > 0)).toBe(true)
  })
})

describe('getSubagentOrchestrationReliability', () => {
  it('returns the catalog value for current frontier models', () => {
    expect(getSubagentOrchestrationReliability('claude-opus-4-7')).toBe('reliable')
    expect(getSubagentOrchestrationReliability('claude-sonnet-4-6')).toBe('reliable')
    expect(getSubagentOrchestrationReliability('claude-haiku-4-5-20251001')).toBe('reliable')
    expect(getSubagentOrchestrationReliability('gpt-5.5')).toBe('reliable')
    expect(getSubagentOrchestrationReliability('gpt-5-mini')).toBe('reliable')
    expect(getSubagentOrchestrationReliability('gpt-5.4-mini')).toBe('reliable')
  })

  it("flags nano as flaky based on the subagent smoke eval", () => {
    expect(getSubagentOrchestrationReliability('gpt-5.4-nano')).toBe('flaky')
  })

  it('returns "unknown" for OpenRouter (dynamic) models', () => {
    expect(getSubagentOrchestrationReliability('openrouter:xai/mimo-v2.5')).toBe('unknown')
    expect(getSubagentOrchestrationReliability('openrouter:anthropic/claude-sonnet-4-6')).toBe('unknown')
  })

  it('returns "unknown" for unrated catalog entries and unknown model ids', () => {
    expect(getSubagentOrchestrationReliability('totally-made-up-model')).toBe('unknown')
    expect(getSubagentOrchestrationReliability('')).toBe('unknown')
    expect(getSubagentOrchestrationReliability(AUTO_MODEL_ID)).toBe('unknown')
  })

  it('resolves aliases before reading capabilities', () => {
    const aliasFor = Object.entries(MODEL_ALIASES).find(([, target]) => {
      const entry = MODEL_CATALOG[target as keyof typeof MODEL_CATALOG] as { capabilities?: { subagentOrchestration?: string } } | undefined
      return entry?.capabilities?.subagentOrchestration === 'reliable'
    })
    if (!aliasFor) return
    const [aliasId] = aliasFor
    expect(getSubagentOrchestrationReliability(aliasId)).toBe('reliable')
  })
})
