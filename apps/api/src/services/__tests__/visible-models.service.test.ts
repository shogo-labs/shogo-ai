// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/services/visible-models.service.ts — the
 * admin-curated, provider-key-gated model resolution shared by the chat
 * picker (`/api/platform/visible-models`, `/api/workspaces/:id/visible-models`)
 * and the `GET /ai/v1/models` gateway listing.
 *
 *   bun test apps/api/src/services/__tests__/visible-models.service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── Mutable mock data ──────────────────────────────────────────────────────

let PLATFORM_SETTINGS: Record<string, string> = {}
let MODEL_DEFS: any[] = []
let CONFIGURED_PROVIDERS = new Set<string>()
let ALLOWED_IDS: Set<string> | null = null

mock.module('../../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where }: any) => {
        const value = PLATFORM_SETTINGS[where.key]
        return value !== undefined ? { key: where.key, value } : null
      },
      upsert: async ({ where, create, update }: any) => {
        PLATFORM_SETTINGS[where.key] = (update ?? create).value
        return { key: where.key, value: PLATFORM_SETTINGS[where.key] }
      },
    },
    modelDefinition: {
      findMany: async (_args?: any) => MODEL_DEFS.filter((m) => m.enabled),
    },
    modelProvider: {
      findMany: async () => [],
    },
  },
}))

// No connected cloud in these tests — always resolve locally.
mock.module('../../lib/federated-upstream', () => ({
  fetchCloudVisibleModels: async () => null,
}))

mock.module('../provider-credentials.service', () => ({
  NATIVE_PROVIDER_ENV_KEY: {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  },
  getNativeProviderApiKeySync: (provider: string) => (CONFIGURED_PROVIDERS.has(provider) ? 'test-key' : null),
}))

// Real `filterToAllowlist` logic (kept in sync with workspace-models.service),
// with `getAllowedModelIds` swapped for a deterministic in-memory value so
// tests don't need a `workspaceModelVisibility` prisma mock.
mock.module('../workspace-models.service', () => ({
  getAllowedModelIds: async (_workspaceId: string) => ALLOWED_IDS,
  filterToAllowlist: (platform: any, allowed: Set<string> | null) => {
    if (allowed === null) return platform
    return {
      catalogModels: platform.catalogModels.filter((m: any) => allowed.has(m.id)),
      openrouterModels: platform.openrouterModels.filter((m: any) => allowed.has(m.id)),
    }
  },
}))

const { primeModelRegistry } = await import('../model-registry.service')
const {
  readVisibleModelsConfig,
  writeVisibleModelsConfig,
  resolveVisibleCatalogModels,
  resolvePlatformVisibleModels,
  resolveVisibleModelsForWorkspace,
  isModelProviderConfigured,
} = await import('../visible-models.service')

function dbModel(overrides: Record<string, unknown>) {
  return {
    provider: 'anthropic',
    providerId: null,
    tier: 'standard',
    family: 'other',
    generation: 'current',
    maxOutputTokens: 8192,
    enabled: true,
    sortOrder: 0,
    aliases: [],
    capabilities: null,
    inputPerMillion: 1,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 2,
    ...overrides,
  }
}

beforeEach(async () => {
  PLATFORM_SETTINGS = {}
  MODEL_DEFS = []
  CONFIGURED_PROVIDERS = new Set(['anthropic', 'openai'])
  ALLOWED_IDS = null
  await primeModelRegistry()
})

describe('isModelProviderConfigured', () => {
  test('custom and local providers are always configured', () => {
    expect(isModelProviderConfigured('custom')).toBe(true)
    expect(isModelProviderConfigured('local')).toBe(true)
  })

  test('native providers are gated on a usable key', () => {
    CONFIGURED_PROVIDERS = new Set(['anthropic'])
    expect(isModelProviderConfigured('anthropic')).toBe(true)
    expect(isModelProviderConfigured('openai')).toBe(false)
  })
})

describe('resolveVisibleCatalogModels — unseeded DB (first-run fallback)', () => {
  test('falls back to the current-generation static catalog, ungated', async () => {
    CONFIGURED_PROVIDERS = new Set() // no provider keys at all
    const models = await resolveVisibleCatalogModels(null)
    const ids = models.map((m) => m.id)

    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('claude-sonnet-5')
    expect(ids).toContain('gpt-5.4-nano')
    // Legacy catalog entries are a routing-only fallback, not listed.
    expect(ids).not.toContain('claude-3-haiku-20240307')
    expect(ids).not.toContain('gpt-4o-mini')
  })
})

describe('resolveVisibleCatalogModels — DB-managed picker', () => {
  test('reflects only enabled DB rows and hides ones missing a provider key', async () => {
    MODEL_DEFS = [
      dbModel({ id: 'db-model-a', apiModel: 'db-model-a', displayName: 'DB Model A', shortDisplayName: 'A', provider: 'anthropic', sortOrder: 0 }),
      dbModel({ id: 'db-model-b', apiModel: 'db-model-b', displayName: 'DB Model B', shortDisplayName: 'B', provider: 'google', sortOrder: 1 }),
      dbModel({ id: 'db-model-disabled', apiModel: 'db-model-disabled', displayName: 'Disabled', shortDisplayName: 'D', provider: 'anthropic', enabled: false }),
    ]
    await primeModelRegistry()
    CONFIGURED_PROVIDERS = new Set(['anthropic']) // google key missing

    const models = await resolveVisibleCatalogModels(null)
    const ids = models.map((m) => m.id)

    expect(ids).toEqual(['db-model-a'])
    // Once the DB has rows, the static catalog is no longer used as a source.
    expect(ids).not.toContain('claude-opus-5')
  })

  test('an explicit catalogIds allowlist resolves each id against the merged catalog', async () => {
    MODEL_DEFS = [
      dbModel({ id: 'db-model-a', apiModel: 'db-model-a', displayName: 'DB Model A', shortDisplayName: 'A', provider: 'anthropic' }),
    ]
    await primeModelRegistry()

    const models = await resolveVisibleCatalogModels(['db-model-a', 'claude-opus-5', 'does-not-exist'])
    expect(models.map((m) => m.id)).toEqual(['db-model-a', 'claude-opus-5'])
  })
})

describe('resolvePlatformVisibleModels — OpenRouter extras', () => {
  test('admin-curated OpenRouter extras persisted via writeVisibleModelsConfig are included', async () => {
    await writeVisibleModelsConfig(
      {
        catalogIds: null,
        openrouterModels: [
          { id: 'openrouter:meta-llama/llama-3.1-405b-instruct', displayName: 'Llama 3.1 405B (OpenRouter)', tier: 'standard' },
        ],
      },
      'user-1',
    )

    const stored = await readVisibleModelsConfig()
    expect(stored.openrouterModels.map((m) => m.id)).toEqual(['openrouter:meta-llama/llama-3.1-405b-instruct'])

    const payload = await resolvePlatformVisibleModels()
    expect(payload.openrouterModels.map((m) => m.id)).toEqual(['openrouter:meta-llama/llama-3.1-405b-instruct'])
  })
})

describe('resolveVisibleModelsForWorkspace', () => {
  test('inherits the full platform set when the workspace has no restriction', async () => {
    ALLOWED_IDS = null
    const resolved = await resolveVisibleModelsForWorkspace('ws-1')
    expect(resolved.catalogModels.length).toBeGreaterThan(1)
    expect(resolved.catalogModels.some((m) => m.id === 'claude-haiku-4-5-20251001')).toBe(true)
  })

  test('narrows the platform set to the workspace allowlist', async () => {
    ALLOWED_IDS = new Set(['claude-haiku-4-5-20251001'])
    const resolved = await resolveVisibleModelsForWorkspace('ws-1')
    expect(resolved.catalogModels.map((m) => m.id)).toEqual(['claude-haiku-4-5-20251001'])
  })

  test('an empty allowlist hides every model', async () => {
    ALLOWED_IDS = new Set()
    const resolved = await resolveVisibleModelsForWorkspace('ws-1')
    expect(resolved.catalogModels).toEqual([])
    expect(resolved.openrouterModels).toEqual([])
  })
})
