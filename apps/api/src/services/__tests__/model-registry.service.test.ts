// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/services/model-registry.service.ts — the merge
 * of the static MODEL_CATALOG with DB-defined models + custom providers.
 *
 *   bun test apps/api/src/services/__tests__/model-registry.service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { encryptSecret } from '../../lib/secret-crypto'
import { calculateUsageCost, MARKUP_MULTIPLIER } from '../../lib/usage-cost'

// A real master key so the registry can decrypt the custom provider key.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

// ─── Mutable mock data ──────────────────────────────────────────────────────
let MODELS: any[] = []
let PROVIDERS: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    modelDefinition: {
      findMany: async (_args?: any) => MODELS.filter((m) => m.enabled),
    },
    modelProvider: {
      findMany: async () => PROVIDERS,
    },
  },
}))

const {
  primeModelRegistry,
  invalidateModelRegistry,
  getMergedCatalogSync,
  getMergedModelEntrySync,
  getDbModelEntriesSync,
  getDbRoutingConfigSync,
  getDbModelPricingSync,
} = await import('../model-registry.service')

const MIMO_KEY = 'sk-mimo-staging-key-abcdef'

function seedMimo() {
  PROVIDERS = [
    {
      id: 'prov-1',
      label: 'MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      protocol: 'openai',
      authStyle: 'bearer',
      encryptedApiKey: encryptSecret(MIMO_KEY),
      enabled: true,
    },
  ]
  MODELS = [
    {
      id: 'mimo-v2.5',
      provider: 'custom',
      providerId: 'prov-1',
      apiModel: 'mimo-v2.5',
      displayName: 'MiMo v2.5',
      shortDisplayName: 'MiMo 2.5',
      tier: 'standard',
      family: 'other',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 1,
      aliases: ['mimo', 'mimo-2.5'],
      capabilities: null,
      inputPerMillion: 1.5,
      cachedInputPerMillion: 0.3,
      cacheWritePerMillion: 2,
      outputPerMillion: 6,
    },
    {
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      providerId: null,
      apiModel: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      shortDisplayName: 'Opus 4.8',
      tier: 'premium',
      family: 'opus',
      generation: 'current',
      maxOutputTokens: 128000,
      enabled: true,
      sortOrder: 0,
      aliases: ['opus'],
      capabilities: { subagentOrchestration: 'reliable' },
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 25,
    },
  ]
}

describe('model-registry.service', () => {
  beforeEach(async () => {
    seedMimo()
    await primeModelRegistry()
  })

  test('merged catalog includes both static and DB models', () => {
    const ids = new Set(getMergedCatalogSync().map((m) => m.id))
    // DB models present
    expect(ids.has('mimo-v2.5')).toBe(true)
    expect(ids.has('claude-opus-4-8')).toBe(true)
    // A known static model is still present
    expect(ids.has('claude-sonnet-4-6')).toBe(true)
  })

  test('getDbModelEntriesSync returns only DB models, not the static catalog', () => {
    const ids = new Set(getDbModelEntriesSync().map((m) => m.id))
    // DB-defined models are present…
    expect(ids.has('mimo-v2.5')).toBe(true)
    expect(ids.has('claude-opus-4-8')).toBe(true)
    // …while static-only catalog entries are excluded (the picker uses this
    // so the admin's DB set is the source of truth).
    expect(ids.has('claude-sonnet-4-6')).toBe(false)
  })

  test('getDbModelEntriesSync drops disabled DB models', async () => {
    MODELS = MODELS.map((m) => (m.id === 'mimo-v2.5' ? { ...m, enabled: false } : m))
    await invalidateModelRegistry()
    const ids = new Set(getDbModelEntriesSync().map((m) => m.id))
    expect(ids.has('mimo-v2.5')).toBe(false)
    expect(ids.has('claude-opus-4-8')).toBe(true)
  })

  test('DB model overrides static on id collision', async () => {
    MODELS.push({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      providerId: null,
      apiModel: 'claude-sonnet-4-6',
      displayName: 'OVERRIDDEN Sonnet',
      shortDisplayName: 'Sonnet*',
      tier: 'premium',
      family: 'sonnet',
      generation: 'current',
      maxOutputTokens: 64000,
      enabled: true,
      sortOrder: null,
      aliases: [],
      capabilities: null,
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      cacheWritePerMillion: 0,
      outputPerMillion: 0,
    })
    await invalidateModelRegistry()
    expect(getMergedModelEntrySync('claude-sonnet-4-6')?.displayName).toBe('OVERRIDDEN Sonnet')
  })

  test('resolves a DB alias to the canonical entry', () => {
    expect(getMergedModelEntrySync('opus')?.id).toBe('claude-opus-4-8')
    expect(getMergedModelEntrySync('mimo')?.id).toBe('mimo-v2.5')
  })

  test('custom provider routing decrypts the key and builds the base URL', () => {
    const routing = getDbRoutingConfigSync('mimo-v2.5')
    expect(routing).toBeDefined()
    expect(routing!.provider).toBe('custom')
    expect(routing!.apiModel).toBe('mimo-v2.5')
    expect(routing!.baseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(routing!.authStyle).toBe('bearer')
    expect(routing!.apiKey).toBe(MIMO_KEY) // decrypted in-memory
  })

  test('native DB model routing carries no baseUrl/apiKey', () => {
    const routing = getDbRoutingConfigSync('claude-opus-4-8')
    expect(routing!.provider).toBe('anthropic')
    expect(routing!.baseUrl).toBeUndefined()
    expect(routing!.apiKey).toBeUndefined()
  })

  test('per-token pricing is exposed and alias-resolvable', () => {
    expect(getDbModelPricingSync('mimo-v2.5')).toEqual({
      inputPerMillion: 1.5,
      cachedInputPerMillion: 0.3,
      cacheWritePerMillion: 2,
      outputPerMillion: 6,
    })
    expect(getDbModelPricingSync('opus')?.outputPerMillion).toBe(25)
  })

  test('disabled models are excluded from the merge', async () => {
    MODELS = MODELS.map((m) => (m.id === 'mimo-v2.5' ? { ...m, enabled: false } : m))
    await invalidateModelRegistry()
    expect(getMergedModelEntrySync('mimo-v2.5')).toBeUndefined()
    expect(getDbRoutingConfigSync('mimo-v2.5')).toBeUndefined()
  })

  test('a disabled provider yields routing without a key', async () => {
    PROVIDERS = PROVIDERS.map((p) => ({ ...p, enabled: false }))
    await invalidateModelRegistry()
    const routing = getDbRoutingConfigSync('mimo-v2.5')
    expect(routing!.provider).toBe('custom')
    expect(routing!.apiKey).toBeUndefined()
    expect(routing!.baseUrl).toBeUndefined()
  })

  test('a UUID-keyed model resolves routing + pricing by its slug alias', async () => {
    // Mirrors the post-migration world: the canonical id is an opaque UUID and
    // the provider slug lives in `apiModel` + `aliases`. Existing references
    // that still hold the slug must resolve to the UUID row.
    const uuid = '11111111-2222-4333-8444-555555555555'
    MODELS = [
      {
        id: uuid,
        provider: 'custom',
        providerId: 'prov-1',
        apiModel: 'mimo-v2.5',
        displayName: 'MiMo v2.5',
        shortDisplayName: 'MiMo 2.5',
        tier: 'standard',
        family: 'other',
        generation: 'current',
        maxOutputTokens: 128000,
        enabled: true,
        sortOrder: 1,
        aliases: ['mimo-v2.5', 'mimo'],
        capabilities: null,
        inputPerMillion: 1.5,
        cachedInputPerMillion: 0.3,
        cacheWritePerMillion: 2,
        outputPerMillion: 6,
      },
    ]
    await invalidateModelRegistry()

    // Canonical UUID lookup works.
    expect(getMergedModelEntrySync(uuid)?.apiModel).toBe('mimo-v2.5')
    expect(getDbRoutingConfigSync(uuid)?.apiModel).toBe('mimo-v2.5')
    // …and so does the legacy slug, via the alias map.
    expect(getMergedModelEntrySync('mimo-v2.5')?.id).toBe(uuid)
    expect(getDbRoutingConfigSync('mimo-v2.5')?.apiKey).toBe(MIMO_KEY)
    expect(getDbModelPricingSync('mimo-v2.5')?.outputPerMillion).toBe(6)
    // Billing keys on the slug resolve to the same per-token rates.
    const { billedUsd } = calculateUsageCost(1_000_000, 0, 'mimo-v2.5')
    expect(billedUsd).toBeCloseTo(1.5 * MARKUP_MULTIPLIER, 10)
  })
})

describe('usage-cost DB per-token billing', () => {
  beforeEach(async () => {
    seedMimo()
    await primeModelRegistry()
  })

  test('bills a DB model at its configured per-token rates (× markup)', () => {
    // mimo-v2.5: input 1.5, cachedInput 0.3, cacheWrite 2, output 6 (per 1M).
    const inputTokens = 1_000_000
    const outputTokens = 500_000
    const cachedInputTokens = 200_000
    const cacheWriteTokens = 100_000
    const { rawUsd, billedUsd } = calculateUsageCost(
      inputTokens,
      outputTokens,
      'mimo-v2.5',
      cachedInputTokens,
      cacheWriteTokens,
    )
    const expectedRaw =
      (inputTokens * 1.5) / 1_000_000 +
      (cacheWriteTokens * 2) / 1_000_000 +
      (cachedInputTokens * 0.3) / 1_000_000 +
      (outputTokens * 6) / 1_000_000
    expect(rawUsd).toBeCloseTo(expectedRaw, 10)
    expect(billedUsd).toBeCloseTo(expectedRaw * MARKUP_MULTIPLIER, 10)
  })

  test('resolves billing through a DB alias', () => {
    const { billedUsd } = calculateUsageCost(1_000_000, 0, 'opus')
    // opus alias -> claude-opus-4-8: input 5 per 1M.
    expect(billedUsd).toBeCloseTo(5 * MARKUP_MULTIPLIER, 10)
  })

  test('zero usage yields zero cost even for DB models', () => {
    expect(calculateUsageCost(0, 0, 'mimo-v2.5')).toEqual({ rawUsd: 0, billedUsd: 0 })
  })

  test('unknown DB id falls back to the static bucket path', () => {
    // A non-DB, non-catalog id should not blow up; it returns a finite cost.
    const { billedUsd } = calculateUsageCost(1000, 1000, 'totally-unknown-model-id')
    expect(Number.isFinite(billedUsd)).toBe(true)
  })
})
