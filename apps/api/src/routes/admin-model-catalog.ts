// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * DB-defined model catalog CRUD (super-admin). Lets new models — including
 * custom OpenAI-compatible providers (e.g. MiMo) — be added entirely from the
 * admin UI without a code release.
 *
 * Mounted at `/api/admin/settings` in `server.ts`, so it inherits the
 * super-admin guard (`app.use('/api/admin/settings/*', …)`) registered there.
 *
 * Provider API keys are encrypted at rest (apps/api/src/lib/secret-crypto.ts)
 * and NEVER returned in plaintext — reads return only a recognizable mask.
 * Every write invalidates the in-memory model registry cache so routing,
 * billing, and the picker reflect the change immediately.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  isSecretCryptoConfigured,
} from '../lib/secret-crypto'
import { invalidateModelRegistry } from '../services/model-registry.service'

const MODEL_PROVIDER_PROTOCOLS = new Set(['openai', 'anthropic'])
const MODEL_PROVIDER_AUTH_STYLES = new Set(['bearer', 'api-key-header'])
const MODEL_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'openrouter', 'local', 'custom'])
const MODEL_TIERS = new Set(['economy', 'standard', 'premium'])
const MODEL_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'gpt', 'other'])
const MODEL_GENERATIONS = new Set(['current', 'legacy'])

/** Shape a ModelProvider row for read responses — never includes the key. */
export function toProviderResponse(row: any) {
  let apiKeyMask = '(configured)'
  let keyDecryptable = true
  try {
    apiKeyMask = maskSecret(decryptSecret(row.encryptedApiKey))
  } catch {
    // Master key absent or blob corrupt: don't expose anything, but flag it
    // so the admin UI can prompt to re-enter the key.
    apiKeyMask = '(unreadable)'
    keyDecryptable = false
  }
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    authStyle: row.authStyle,
    enabled: row.enabled,
    apiKeyMask,
    keyDecryptable,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  }
}

/** Coerce + clamp a per-million USD price to a finite, non-negative number. */
function sanitizePrice(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function sanitizeAliases(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

export function toModelResponse(row: any) {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.providerId ?? null,
    apiModel: row.apiModel,
    displayName: row.displayName,
    shortDisplayName: row.shortDisplayName,
    tier: row.tier,
    family: row.family,
    generation: row.generation,
    maxOutputTokens: row.maxOutputTokens,
    enabled: row.enabled,
    sortOrder: row.sortOrder ?? null,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    capabilities: row.capabilities ?? null,
    inputPerMillion: row.inputPerMillion,
    cachedInputPerMillion: row.cachedInputPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    outputPerMillion: row.outputPerMillion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  }
}

/**
 * Router for super-admin model + provider management. Mount under
 * `/api/admin/settings`.
 */
export function adminModelCatalogRoutes() {
  const router = new Hono()

  // GET /model-providers — list custom providers (masked key).
  router.get('/model-providers', async (c) => {
    try {
      const rows = await (prisma as any).modelProvider.findMany({ orderBy: { createdAt: 'asc' } })
      return c.json({ providers: rows.map(toProviderResponse) })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /model-providers — create a custom provider.
  router.post('/model-providers', async (c) => {
    try {
      const body = await c.req.json()
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const label = typeof body?.label === 'string' ? body.label.trim() : ''
      const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
      const protocol = typeof body?.protocol === 'string' ? body.protocol : 'openai'
      const authStyle = typeof body?.authStyle === 'string' ? body.authStyle : 'bearer'
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : ''
      const enabled = body?.enabled !== false

      if (!label) return c.json({ error: 'label is required' }, 400)
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return c.json({ error: 'baseUrl must be an http(s) URL' }, 400)
      if (!MODEL_PROVIDER_PROTOCOLS.has(protocol)) return c.json({ error: 'invalid protocol' }, 400)
      if (!MODEL_PROVIDER_AUTH_STYLES.has(authStyle)) return c.json({ error: 'invalid authStyle' }, 400)
      if (!apiKey) return c.json({ error: 'apiKey is required' }, 400)
      if (!isSecretCryptoConfigured()) {
        return c.json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on this server; cannot store provider keys.' }, 503)
      }

      const created = await (prisma as any).modelProvider.create({
        data: {
          label,
          baseUrl,
          protocol,
          authStyle,
          encryptedApiKey: encryptSecret(apiKey),
          enabled,
          updatedBy: userId,
        },
      })
      await invalidateModelRegistry()
      return c.json({ ok: true, provider: toProviderResponse(created) })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // PUT /model-providers/:id — update a custom provider.
  // `apiKey` is only re-encrypted when a non-empty value is supplied; omit it
  // to keep the existing key.
  router.put('/model-providers/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const data: any = { updatedBy: userId }
      if (typeof body?.label === 'string') {
        if (!body.label.trim()) return c.json({ error: 'label cannot be empty' }, 400)
        data.label = body.label.trim()
      }
      if (typeof body?.baseUrl === 'string') {
        if (!/^https?:\/\//.test(body.baseUrl.trim())) return c.json({ error: 'baseUrl must be an http(s) URL' }, 400)
        data.baseUrl = body.baseUrl.trim()
      }
      if (typeof body?.protocol === 'string') {
        if (!MODEL_PROVIDER_PROTOCOLS.has(body.protocol)) return c.json({ error: 'invalid protocol' }, 400)
        data.protocol = body.protocol
      }
      if (typeof body?.authStyle === 'string') {
        if (!MODEL_PROVIDER_AUTH_STYLES.has(body.authStyle)) return c.json({ error: 'invalid authStyle' }, 400)
        data.authStyle = body.authStyle
      }
      if (typeof body?.enabled === 'boolean') data.enabled = body.enabled
      if (typeof body?.apiKey === 'string' && body.apiKey.length > 0) {
        if (!isSecretCryptoConfigured()) {
          return c.json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on this server; cannot store provider keys.' }, 503)
        }
        data.encryptedApiKey = encryptSecret(body.apiKey)
      }

      const updated = await (prisma as any).modelProvider.update({ where: { id }, data })
      await invalidateModelRegistry()
      return c.json({ ok: true, provider: toProviderResponse(updated) })
    } catch (err: any) {
      if (err?.code === 'P2025') return c.json({ error: 'provider not found' }, 404)
      return c.json({ error: err.message }, 500)
    }
  })

  // DELETE /model-providers/:id — remove a custom provider.
  // Models linked to it have their providerId nulled (FK onDelete: SetNull);
  // the caller should reassign or disable those models.
  router.delete('/model-providers/:id', async (c) => {
    try {
      const id = c.req.param('id')
      await (prisma as any).modelProvider.delete({ where: { id } })
      await invalidateModelRegistry()
      return c.json({ ok: true })
    } catch (err: any) {
      if (err?.code === 'P2025') return c.json({ error: 'provider not found' }, 404)
      return c.json({ error: err.message }, 500)
    }
  })

  // GET /models — list DB-defined models.
  router.get('/models', async (c) => {
    try {
      const rows = await (prisma as any).modelDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
      return c.json({ models: rows.map(toModelResponse) })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /models — create a DB-defined model.
  router.post('/models', async (c) => {
    try {
      const body = await c.req.json()
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      const provider = typeof body?.provider === 'string' ? body.provider : ''
      const apiModel = typeof body?.apiModel === 'string' ? body.apiModel.trim() : ''
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
      const shortDisplayName = typeof body?.shortDisplayName === 'string' && body.shortDisplayName.trim()
        ? body.shortDisplayName.trim()
        : displayName

      if (!id) return c.json({ error: 'id is required' }, 400)
      if (!MODEL_PROVIDERS.has(provider)) return c.json({ error: 'invalid provider' }, 400)
      if (!apiModel) return c.json({ error: 'apiModel is required' }, 400)
      if (!displayName) return c.json({ error: 'displayName is required' }, 400)

      const tier = MODEL_TIERS.has(body?.tier) ? body.tier : 'standard'
      const family = MODEL_FAMILIES.has(body?.family) ? body.family : 'other'
      const generation = MODEL_GENERATIONS.has(body?.generation) ? body.generation : 'current'
      const maxOutputTokens = Number.isFinite(body?.maxOutputTokens) && body.maxOutputTokens > 0
        ? Math.floor(body.maxOutputTokens)
        : 64000

      let providerId: string | null = null
      if (provider === 'custom') {
        providerId = typeof body?.providerId === 'string' ? body.providerId : ''
        if (!providerId) return c.json({ error: 'providerId is required for custom-provider models' }, 400)
        const exists = await (prisma as any).modelProvider.findUnique({ where: { id: providerId } })
        if (!exists) return c.json({ error: 'providerId does not reference an existing provider' }, 400)
      }

      const created = await (prisma as any).modelDefinition.create({
        data: {
          id,
          provider,
          providerId,
          apiModel,
          displayName,
          shortDisplayName,
          tier,
          family,
          generation,
          maxOutputTokens,
          enabled: body?.enabled !== false,
          sortOrder: Number.isFinite(body?.sortOrder) ? Math.floor(body.sortOrder) : null,
          aliases: sanitizeAliases(body?.aliases),
          capabilities: body?.capabilities && typeof body.capabilities === 'object' ? body.capabilities : null,
          inputPerMillion: sanitizePrice(body?.inputPerMillion),
          cachedInputPerMillion: sanitizePrice(body?.cachedInputPerMillion),
          cacheWritePerMillion: sanitizePrice(body?.cacheWritePerMillion),
          outputPerMillion: sanitizePrice(body?.outputPerMillion),
          updatedBy: userId,
        },
      })
      await invalidateModelRegistry()
      return c.json({ ok: true, model: toModelResponse(created) })
    } catch (err: any) {
      if (err?.code === 'P2002') return c.json({ error: 'a model with that id already exists' }, 409)
      return c.json({ error: err.message }, 500)
    }
  })

  // PUT /models/:id — update a DB-defined model.
  router.put('/models/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json()
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const data: any = { updatedBy: userId }
      if (typeof body?.provider === 'string') {
        if (!MODEL_PROVIDERS.has(body.provider)) return c.json({ error: 'invalid provider' }, 400)
        data.provider = body.provider
      }
      if (typeof body?.apiModel === 'string' && body.apiModel.trim()) data.apiModel = body.apiModel.trim()
      if (typeof body?.displayName === 'string' && body.displayName.trim()) data.displayName = body.displayName.trim()
      if (typeof body?.shortDisplayName === 'string' && body.shortDisplayName.trim()) data.shortDisplayName = body.shortDisplayName.trim()
      if (typeof body?.tier === 'string') {
        if (!MODEL_TIERS.has(body.tier)) return c.json({ error: 'invalid tier' }, 400)
        data.tier = body.tier
      }
      if (typeof body?.family === 'string') {
        if (!MODEL_FAMILIES.has(body.family)) return c.json({ error: 'invalid family' }, 400)
        data.family = body.family
      }
      if (typeof body?.generation === 'string') {
        if (!MODEL_GENERATIONS.has(body.generation)) return c.json({ error: 'invalid generation' }, 400)
        data.generation = body.generation
      }
      if (Number.isFinite(body?.maxOutputTokens) && body.maxOutputTokens > 0) data.maxOutputTokens = Math.floor(body.maxOutputTokens)
      if (typeof body?.enabled === 'boolean') data.enabled = body.enabled
      if (body?.sortOrder === null || Number.isFinite(body?.sortOrder)) {
        data.sortOrder = body.sortOrder === null ? null : Math.floor(body.sortOrder)
      }
      if (Array.isArray(body?.aliases)) data.aliases = sanitizeAliases(body.aliases)
      if ('capabilities' in (body ?? {})) {
        data.capabilities = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : null
      }
      for (const key of ['inputPerMillion', 'cachedInputPerMillion', 'cacheWritePerMillion', 'outputPerMillion'] as const) {
        if (body?.[key] !== undefined) data[key] = sanitizePrice(body[key])
      }

      // Keep the custom-provider FK consistent.
      const effectiveProvider = data.provider ?? (await (prisma as any).modelDefinition.findUnique({ where: { id } }))?.provider
      if (effectiveProvider === 'custom') {
        if (typeof body?.providerId === 'string' && body.providerId) {
          const exists = await (prisma as any).modelProvider.findUnique({ where: { id: body.providerId } })
          if (!exists) return c.json({ error: 'providerId does not reference an existing provider' }, 400)
          data.providerId = body.providerId
        }
      } else if (data.provider && data.provider !== 'custom') {
        data.providerId = null
      }

      const updated = await (prisma as any).modelDefinition.update({ where: { id }, data })
      await invalidateModelRegistry()
      return c.json({ ok: true, model: toModelResponse(updated) })
    } catch (err: any) {
      if (err?.code === 'P2025') return c.json({ error: 'model not found' }, 404)
      return c.json({ error: err.message }, 500)
    }
  })

  // DELETE /models/:id — remove a DB-defined model.
  router.delete('/models/:id', async (c) => {
    try {
      const id = c.req.param('id')
      await (prisma as any).modelDefinition.delete({ where: { id } })
      await invalidateModelRegistry()
      return c.json({ ok: true })
    } catch (err: any) {
      if (err?.code === 'P2025') return c.json({ error: 'model not found' }, 404)
      return c.json({ error: err.message }, 500)
    }
  })

  return router
}
