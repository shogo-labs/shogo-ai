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
let providerSeq = 0

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
  },
}))

mock.module('../../services/model-registry.service', () => ({
  invalidateModelRegistry: async () => {},
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

describe('admin models CRUD', () => {
  test('creates a native model and lists it', async () => {
    const res = await post('/models', {
      id: 'claude-opus-4-8',
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
    expect(data.model.id).toBe('claude-opus-4-8')
    // Non-string / blank aliases are sanitized out.
    expect(data.model.aliases).toEqual(['opus'])
    const list = await (await get('/models')).json() as any
    expect(list.models.map((m: any) => m.id)).toContain('claude-opus-4-8')
  })

  test('rejects an invalid provider and a duplicate id', async () => {
    expect((await post('/models', { id: 'x', provider: 'bogus', apiModel: 'x', displayName: 'X' })).status).toBe(400)
    await post('/models', { id: 'dup', provider: 'openai', apiModel: 'dup', displayName: 'Dup' })
    expect((await post('/models', { id: 'dup', provider: 'openai', apiModel: 'dup', displayName: 'Dup' })).status).toBe(409)
  })

  test('custom model requires a valid providerId', async () => {
    // No provider exists yet.
    expect((await post('/models', {
      id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo', providerId: 'ghost',
    })).status).toBe(400)

    const prov = await (await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-key-here-1234',
    })).json() as any
    const res = await post('/models', {
      id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo v2.5', providerId: prov.provider.id,
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.providerId).toBe(prov.provider.id)
  })

  test('update edits fields; switching off custom nulls the providerId', async () => {
    const prov = await (await post('/model-providers', {
      label: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-key-here-1234',
    })).json() as any
    await post('/models', {
      id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5', displayName: 'MiMo', providerId: prov.provider.id,
    })
    const res = await put('/models/mimo-v2.5', { provider: 'openai', displayName: 'Now OpenAI' })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.model.displayName).toBe('Now OpenAI')
    expect(data.model.providerId).toBeNull()
  })

  test('update/delete return 404 for an unknown id', async () => {
    expect((await put('/models/nope', { displayName: 'X' })).status).toBe(404)
    expect((await del('/models/nope')).status).toBe(404)
  })
})
