// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let advancedAccess = false

mock.module('../services/billing.service', () => ({
  hasAdvancedModelAccess: async () => advancedAccess,
}))

mock.module('../services/public-models.service', () => ({
  resolvePublicModelSync: (id: string) =>
    id === 'hoshi-1.0'
      ? { publicId: id, displayName: 'Hoshi 1.0', backingModelId: 'mimo-v2.5', enabled: true }
      : null,
}))

const OPUS_UUID = '8947628a-1415-4b3a-90c3-63f8a85c16b7'

// Like the real registry on the local/desktop entry point: empty until the
// first load completes.
let registryLoaded = false
mock.module('../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) =>
    id === 'local-premium'
      ? { id, provider: 'local', tier: 'premium' }
      : undefined,
  ensureModelRegistryLoaded: async () => {
    await Promise.resolve()
    registryLoaded = true
  },
  getDbModelEntriesSync: () => registryLoaded ? [
    { id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    { id: 'gpt-live-uuid', provider: 'openai', apiModel: 'gpt-live-1', kind: 'live' },
  ] : [],
  getCloudModelEntriesSync: () => registryLoaded ? [
    { id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5' },
    { id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5' },
  ] : [],
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === 'agent-model.default-mode' ? { value: 'auto' } : null,
    },
  },
}))

const {
  resolveEffectiveAgentModelDefaults,
  resolveAgentModelEnv,
  isModelAccessibleForWorkspace,
  serializeAutoTierMapEnv,
  serializeModelEntryEnv,
} = await import('../lib/runtime/agent-model-defaults')
const { setSummarizerModelId } = await import('../lib/summarizer-model')
const {
  setAgentModeOverrides,
  setAutoTierOverrides,
} = await import('@shogo/model-catalog')

beforeEach(() => {
  advancedAccess = false
  setSummarizerModelId(null)
  setAgentModeOverrides({
    basic: 'claude-haiku-4-5-20251001',
    advanced: 'claude-sonnet-4-6',
  })
  setAutoTierOverrides({
    economy: 'gpt-5.4-nano',
    standard: 'claude-sonnet-4-6',
    premium: 'claude-sonnet-4-6',
  })
})

describe('agent model defaults', () => {
  test('caps advanced Auto tiers to an accessible economy fallback', async () => {
    const defaults = await resolveEffectiveAgentModelDefaults('ws-free')

    expect(defaults.defaultMode).toBe('auto')
    expect(defaults.autoTiers.economy.id).toBe('gpt-5.4-nano')
    expect(defaults.autoTiers.standard.id).toBe('gpt-5.4-nano')
    expect(defaults.autoTiers.premium.id).toBe('gpt-5.4-nano')
    expect(defaults.basic).toBe('claude-haiku-4-5-20251001')
    expect(defaults.advanced).toBe('gpt-5.4-nano')
    expect(defaults.hasAdvancedModelAccess).toBe(false)
  })

  test('keeps the cloud-configured Hoshi model for an entitled workspace', async () => {
    advancedAccess = true
    setAgentModeOverrides({ basic: 'hoshi-1.0', advanced: 'hoshi-1.0' })
    setAutoTierOverrides({
      economy: 'hoshi-1.0',
      standard: 'hoshi-1.0',
      premium: 'hoshi-1.0',
    })

    const defaults = await resolveEffectiveAgentModelDefaults('ws-pro')

    expect(defaults.basic).toBe('mimo-v2.5')
    expect(defaults.advanced).toBe('mimo-v2.5')
    expect(defaults.autoTiers.premium).toEqual({ id: 'mimo-v2.5', provider: 'custom' })
  })

  test('keeps DB-defined local models accessible regardless of their tier', async () => {
    expect(await isModelAccessibleForWorkspace('ws-free', 'local-premium')).toBe(true)
  })

  test('serializes all configured Auto tiers for the runtime gateway', () => {
    expect(serializeAutoTierMapEnv({
      economy: { id: 'mimo-v2.5', provider: 'custom' },
      standard: { id: 'mimo-v2.5', provider: 'custom' },
      premium: { id: 'mimo-v2.5', provider: 'custom' },
    })).toBe(JSON.stringify({
      economy: { id: 'mimo-v2.5', provider: 'custom' },
      standard: { id: 'mimo-v2.5', provider: 'custom' },
      premium: { id: 'mimo-v2.5', provider: 'custom' },
    }))
  })

  test('falls back to locally resolved values when cloud defaults are unavailable', async () => {
    const env = await resolveAgentModelEnv('ws-free')
    expect(env.AGENT_BASIC_MODEL).toBe('claude-haiku-4-5-20251001')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP).premium).toEqual({
      id: 'gpt-5.4-nano',
      provider: 'openai',
    })
  })

  test('resolves the admin summarizer through public aliases for an entitled workspace', async () => {
    advancedAccess = true
    setSummarizerModelId('hoshi-1.0')
    const defaults = await resolveEffectiveAgentModelDefaults('ws-pro')
    expect(defaults.summarizer).toEqual({ id: 'mimo-v2.5', provider: 'custom' })

    const env = await resolveAgentModelEnv('ws-pro')
    expect(JSON.parse(env.AGENT_SUMMARIZER_MODEL!)).toEqual({ id: 'mimo-v2.5', provider: 'custom' })
  })

  test('caps an inaccessible summarizer to the economy fallback', async () => {
    setSummarizerModelId('hoshi-1.0')
    const defaults = await resolveEffectiveAgentModelDefaults('ws-free')
    expect(defaults.summarizer.id).toBe('gpt-5.4-nano')
  })

  test('passes DB and cloud chat models to the runtime as AGENT_MODEL_REGISTRY', async () => {
    const env = await resolveAgentModelEnv('ws-free')
    expect(JSON.parse(env.AGENT_MODEL_REGISTRY!)).toEqual([
      { id: OPUS_UUID, provider: 'anthropic', apiModel: 'claude-opus-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5' },
    ])
  })

  test('serializes a single model entry, omitting absent fields', () => {
    expect(serializeModelEntryEnv(undefined)).toBeUndefined()
    expect(serializeModelEntryEnv({ id: 'gpt-5.4-nano' })).toBe(JSON.stringify({ id: 'gpt-5.4-nano' }))
    expect(serializeModelEntryEnv({ id: 'mimo-v2.5', provider: 'custom', upstream: 'openrouter' }))
      .toBe(JSON.stringify({ id: 'mimo-v2.5', provider: 'custom', upstream: 'openrouter' }))
  })
})
