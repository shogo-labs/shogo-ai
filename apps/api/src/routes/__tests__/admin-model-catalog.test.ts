// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// 32-byte master key so the routes can encrypt provider keys at rest.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

/**
 * Route tests for the super-admin DB-defined model catalog CRUD.
 *
 *   bun test apps/api/src/routes/__tests__/admin-model-catalog.test.ts
 *
 * Verifies that provider keys are encrypted at rest and ONLY returned masked,
 * plus the create/update/delete + validation behavior for providers + models.
 * Prisma is backed by a small in-memory store; the registry-cache invalidation
 * is stubbed (its behavior is covered by the registry service test).
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

// ─── In-memory prisma store ───────────────────────────────────────────────
let providers: Map<string, any>
let models: Map<string, any>
let settings: Map<string, any>
let providerSeq = 0

// Known backing model ids the registry "resolves" for public-model validation.
const KNOWN_BACKING: Record<string, string> = {
  'claude-opus-4-7': 'Claude Opus 4.7',
  'gpt-5.5': 'GPT-5.5',
}

function notFound(): never {
  const e: any = new Error('Record not found')
  e.code = 'P2025'
  throw e
}

mock.module('../../lib/prisma', () => withPrismaExports({
  prisma: {
    modelProvider: {
      findMany: async () => [...providers.values()],
      findUnique: async ({ where }: any) => providers.get(where.id) ?? null,
      create: async ({ data }: any) => {
        const id = `prov-${++providerSeq}`
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }
        providers.set(id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const existing = providers.get(where.id)
        if (!existing) notFound()
        const row = { ...existing, ...data, updatedAt: new Date() }
        providers.set(where.id, row)
        return row
      },
      delete: async ({ where }: any) => {
        if (!providers.has(where.id)) notFound()
        const row = providers.get(where.id)
        providers.delete(where.id)
        return row
      },
    },
    modelDefinition: {
      findMany: async () => [...models.values()],
      findUnique: async ({ where }: any) => models.get(where.id) ?? null,
      findFirst: async ({ where }: any) => {
        for (const m of models.values()) {
          if (where?.provider != null && m.provider !== where.provider) continue
          if (where?.apiModel != null && m.apiModel !== where.apiModel) continue
          return m
        }
        return null
      },
      create: async ({ data }: any) => {
        if (models.has(data.id)) {
          const e: any = new Error('Unique constraint')
          e.code = 'P2002'
          throw e
        }
        const row = { createdAt: new Date(), updatedAt: new Date(), ...data }
        models.set(data.id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const existing = models.get(where.id)
        if (!existing) notFound()
        const row = { ...existing, ...data, updatedAt: new Date() }
        models.set(where.id, row)
        return row
      },
      delete: async ({ where }: any) => {
        if (!models.has(where.id)) notFound()
        const row = models.get(where.id)
        models.delete(where.id)
        return row
      },
    },
    platformSetting: {
      findUnique: async ({ where }: any) => settings.get(where.key) ?? null,
      upsert: async ({ where, update, create }: any) => {
        const existing = settings.get(where.key)
        const row = existing ? { ...existing, ...update } : { key: where.key, ...create }
        settings.set(where.key, row)
        return row
      },
    },
  },
}))

mock.module('../../services/model-registry.service', () => ({
  invalidateModelRegistry: async () => {},
  getMergedModelEntrySync: (id: string) =>
    KNOWN_BACKING[id] ? { id, displayName: KNOWN_BACKING[id] } : undefined,
}))

const { adminModelCatalogRoutes } = await import('../admin-model-catalog')

function post(path: string, body: any) {
  return adminModelCatalogRoutes().request(`http://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function put(path: string, body: any) {
  return adminModelCatalogRoutes().request(`http://api.test${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function del(path: string) {
  return adminModelCatalogRoutes().request(`http://api.test${path}`, { method: 'DELETE' })
}
function get(path: string) {
  return adminModelCatalogRoutes().request(`http://api.test${path}`)
}

beforeEach(() => {
  providers = new Map()
  models = new Map()
  settings = new Map()
  providerSeq = 0
})

describe('admin model-providers CRUD', () => {
  test('create encrypts the key and only returns a mask', async () => {
    const res = await post('/model-providers', {
      label: 'MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      protocol: 'openai',
      authStyle: 'bearer',
      apiKey: 'sk-mimo-super-secret-staging-key',
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    // The response must NEVER include the plaintext key or the ciphertext.
    expect(data.provider.apiKey).toBeUndefined()
    expect(data.provider.encryptedApiKey).toBeUndefined()
    expect(data.provider.apiKeyMask).toBe('sk-m…-key')
    expect(data.provider.keyDecryptable).toBe(true)
    // The stored row keeps the ciphertext, not the plaintext.
    const stored = [...providers.values()][0]
    expect(stored.encryptedApiKey).toBeTruthy()
    expect(stored.encryptedApiKey).not.toContain('sk-mimo-super-secret-staging-key')
  })

  test('list returns masked keys only', async () => {
    await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-abcdefghijklmnop',
    })
    const res = await get('/model-providers')
    const data = await res.json() as any
    expect(data.providers).toHaveLength(1)
    expect(data.providers[0].apiKeyMask).toBe('sk-a…mnop')
    expect(JSON.stringify(data)).not.toContain('sk-abcdefghijklmnop')
  })

  test('rejects a missing key, bad URL, and bad protocol', async () => {
    expect((await post('/model-providers', { label: 'X', baseUrl: 'https://x/v1' })).status).toBe(400)
    expect((await post('/model-providers', { label: 'X', baseUrl: 'ftp://x', apiKey: 'k' })).status).toBe(400)
    expect((await post('/model-providers', { label: 'X', baseUrl: 'https://x/v1', protocol: 'bogus', apiKey: 'k' })).status).toBe(400)
  })

  test('503 when the master key is not configured', async () => {
    const saved = process.env.SECRETS_ENCRYPTION_KEY
    delete process.env.SECRETS_ENCRYPTION_KEY
    try {
      const res = await post('/model-providers', {
        label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-xyz',
      })
      expect(res.status).toBe(503)
    } finally {
      process.env.SECRETS_ENCRYPTION_KEY = saved
    }
  })

  test('update keeps the existing key when apiKey is omitted', async () => {
    const created = await (await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-original-key-value',
    })).json() as any
    const id = created.provider.id
    const before = providers.get(id).encryptedApiKey
    const res = await put(`/model-providers/${id}`, { label: 'MiMo Renamed' })
    expect(res.status).toBe(200)
    expect(providers.get(id).encryptedApiKey).toBe(before) // unchanged
    expect(providers.get(id).label).toBe('MiMo Renamed')
  })

  test('delete returns 404 for an unknown id', async () => {
    expect((await del('/model-providers/nope')).status).toBe(404)
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('admin models CRUD', () => {
  test('mints a UUID id (ignoring any client id) and keeps apiModel addressable', async () => {
    const res = await post('/models', {
      id: 'claude-opus-4-8', // ignored — the server always mints a UUID
      provider: 'anthropic',
      apiModel: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      shortDisplayName: 'Opus 4.8',
      tier: 'premium',
      family: 'opus',
      maxOutputTokens: 128000,
      aliases: ['opus', '  ', 123],
      inputPerMillion: 5,
      outputPerMillion: 25,
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    // The canonical id is an opaque UUID, NOT the provider slug.
    expect(data.model.id).toMatch(UUID_RE)
    expect(data.model.id).not.toBe('claude-opus-4-8')
    expect(data.model.apiModel).toBe('claude-opus-4-8')
    // Sanitized admin aliases + the apiModel slug, so the model stays
    // addressable by its human-readable name.
    expect(data.model.aliases).toContain('opus')
    expect(data.model.aliases).toContain('claude-opus-4-8')
    const list = await (await get('/models')).json() as any
    expect(list.models.map((m: any) => m.apiModel)).toContain('claude-opus-4-8')
  })

  test('rejects an invalid provider and a missing apiModel', async () => {
    expect((await post('/models', { provider: 'bogus', apiModel: 'x', displayName: 'X' })).status).toBe(400)
    expect((await post('/models', { provider: 'openai', displayName: 'X' })).status).toBe(400)
  })

  test('allows two catalog entries for the same upstream model (distinct UUIDs)', async () => {
    const a = await (await post('/models', { provider: 'openai', apiModel: 'gpt-5', displayName: 'GPT-5 A' })).json() as any
    const b = await (await post('/models', { provider: 'openai', apiModel: 'gpt-5', displayName: 'GPT-5 B' })).json() as any
    expect(a.model.id).toMatch(UUID_RE)
    expect(b.model.id).toMatch(UUID_RE)
    expect(a.model.id).not.toBe(b.model.id)
  })

  test('custom model requires a valid providerId', async () => {
    // No provider exists yet.
    expect((await post('/models', {
      provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo', providerId: 'ghost',
    })).status).toBe(400)

    const prov = await (await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-key-here-1234',
    })).json() as any
    const res = await post('/models', {
      provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo v2.5', providerId: prov.provider.id,
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.providerId).toBe(prov.provider.id)
  })

  test('update edits fields; switching off custom nulls the providerId', async () => {
    const prov = await (await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-key-here-1234',
    })).json() as any
    const created = await (await post('/models', {
      provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo', providerId: prov.provider.id,
    })).json() as any
    const res = await put(`/models/${created.model.id}`, { provider: 'openai', displayName: 'Now OpenAI' })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.displayName).toBe('Now OpenAI')
    expect(data.model.providerId).toBeNull()
  })

  test('update/delete return 404 for an unknown id', async () => {
    expect((await put('/models/nope', { displayName: 'X' })).status).toBe(404)
    expect((await del('/models/nope')).status).toBe(404)
  })

  test('persists picker metadata (description, contextWindow, reasoningEffort)', async () => {
    const res = await post('/models', {
      provider: 'anthropic',
      apiModel: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      description: "Anthropic's smartest model, great for difficult tasks.",
      contextWindow: 200000,
      reasoningEffort: 'medium',
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.description).toBe("Anthropic's smartest model, great for difficult tasks.")
    expect(data.model.contextWindow).toBe(200000)
    expect(data.model.reasoningEffort).toBe('medium')
  })

  test('rejects an invalid reasoningEffort on create and update', async () => {
    expect((await post('/models', {
      provider: 'openai', apiModel: 'x', displayName: 'X', reasoningEffort: 'turbo',
    })).status).toBe(400)

    const ok = await (await post('/models', { provider: 'openai', apiModel: 'x', displayName: 'X' })).json() as any
    expect((await put(`/models/${ok.model.id}`, { reasoningEffort: 'turbo' })).status).toBe(400)
    // A valid level updates cleanly.
    const updated = await put(`/models/${ok.model.id}`, { reasoningEffort: 'high' })
    expect(updated.status).toBe(200)
    expect((await updated.json() as any).model.reasoningEffort).toBe('high')
  })

  test('update clears metadata when passed null/empty', async () => {
    const created = await (await post('/models', {
      provider: 'openai', apiModel: 'x', displayName: 'X',
      description: 'temporary', contextWindow: 128000, reasoningEffort: 'low',
    })).json() as any
    const res = await put(`/models/${created.model.id}`, { description: '  ', contextWindow: 0, reasoningEffort: null })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.description).toBeNull()
    expect(data.model.contextWindow).toBeNull()
    expect(data.model.reasoningEffort).toBeNull()
  })

  test('discovery-enable keys on (provider, apiModel): UUID id + slug alias, idempotent toggle', async () => {
    const enable = (models: any[]) =>
      adminModelCatalogRoutes().request('http://api.test/providers/openai/models/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models }),
      })

    expect((await enable([{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', enabled: true }])).status).toBe(200)
    let list = await (await get('/models')).json() as any
    expect(list.models).toHaveLength(1)
    const row = list.models[0]
    expect(row.id).toMatch(UUID_RE)
    expect(row.apiModel).toBe('gpt-5-mini')
    expect(row.aliases).toContain('gpt-5-mini')

    // Re-enabling the same slug must not create a duplicate row.
    await enable([{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', enabled: false }])
    list = await (await get('/models')).json() as any
    expect(list.models).toHaveLength(1)
    expect(list.models[0].id).toBe(row.id)
    expect(list.models[0].enabled).toBe(false)
  })
})

describe('admin public-models', () => {
  test('GET returns an empty list when unset', async () => {
    const res = await get('/public-models')
    expect(res.status).toBe(200)
    expect((await res.json() as any).models).toEqual([])
  })

  test('PUT persists the alias map and enriches reads with backing validity', async () => {
    const res = await put('/public-models', {
      models: [
        { publicId: 'hoshi-1.0', displayName: 'Hoshi 1.0', backingModelId: 'claude-opus-4-7' },
      ],
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.models).toHaveLength(1)
    expect(data.models[0]).toMatchObject({
      publicId: 'hoshi-1.0',
      displayName: 'Hoshi 1.0',
      backingModelId: 'claude-opus-4-7',
      enabled: true,
    })

    // Stored as JSON in the platform_settings row.
    expect(JSON.parse(settings.get('public-models').value)).toHaveLength(1)

    // Read back enriches with backingValid + backingDisplayName.
    const read = await (await get('/public-models')).json() as any
    expect(read.models[0].backingValid).toBe(true)
    expect(read.models[0].backingDisplayName).toBe('Claude Opus 4.7')
  })

  test('PUT rejects a backingModelId that does not resolve', async () => {
    const res = await put('/public-models', {
      models: [{ publicId: 'ghost-1.0', backingModelId: 'no-such-model' }],
    })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('does not resolve')
  })

  test('PUT rejects entries missing publicId or backingModelId, and duplicates', async () => {
    expect((await put('/public-models', { models: [{ backingModelId: 'gpt-5.5' }] })).status).toBe(400)
    expect((await put('/public-models', { models: [{ publicId: 'x' }] })).status).toBe(400)
    expect(
      (await put('/public-models', {
        models: [
          { publicId: 'dup', backingModelId: 'gpt-5.5' },
          { publicId: 'dup', backingModelId: 'claude-opus-4-7' },
        ],
      })).status,
    ).toBe(400)
  })

  test('PUT requires a models array', async () => {
    expect((await put('/public-models', {})).status).toBe(400)
  })

  test('GET marks a stale backing model as invalid', async () => {
    // Seed a row whose backing id is no longer known to the registry.
    settings.set('public-models', {
      key: 'public-models',
      value: JSON.stringify([
        { publicId: 'legacy-1.0', displayName: 'Legacy', backingModelId: 'retired-model', enabled: true },
      ]),
    })
    const read = await (await get('/public-models')).json() as any
    expect(read.models[0].backingValid).toBe(false)
    expect(read.models[0].backingDisplayName).toBeNull()
  })
})
