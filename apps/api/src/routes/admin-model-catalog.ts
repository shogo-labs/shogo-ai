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
import {
  SUPPORTED_NATIVE_PROVIDERS,
  isNativeProvider,
  getNativeProviderApiKeySync,
  getNativeProviderKeyInfoSync,
  setNativeProviderKey,
} from '../services/provider-credentials.service'
import {
  resolveEnablePricing,
  refreshModelPricingFromLiteLLM,
  getPricingRefreshedAt,
  isPricingStale,
} from '../services/model-pricing-catalog.service'

const MODEL_PROVIDER_PROTOCOLS = new Set(['openai', 'anthropic'])
const MODEL_PROVIDER_AUTH_STYLES = new Set(['bearer', 'api-key-header'])
const MODEL_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'openrouter', 'local', 'custom'])
const MODEL_TIERS = new Set(['economy', 'standard', 'premium'])
const MODEL_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'gpt', 'other'])
const MODEL_GENERATIONS = new Set(['current', 'legacy'])
const MODEL_REASONING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

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

/** Coerce an optional positive-integer context window (tokens), else null. */
function sanitizeContextWindow(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
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
    description: row.description ?? null,
    contextWindow: row.contextWindow ?? null,
    reasoningEffort: row.reasoningEffort ?? null,
    inputPerMillion: row.inputPerMillion,
    cachedInputPerMillion: row.cachedInputPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    outputPerMillion: row.outputPerMillion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null,
  }
}

// Providers we can discover live + fully route today. Google is intentionally
// excluded until chat routing lands (see plan "Deferred"), so it can't be
// half-enabled here. OpenRouter's catalog is public, so it discovers even
// without a key.
const DISCOVERY_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter'])

interface DiscoveredModel {
  id: string
  displayName: string
  contextLength?: number
  inputPerMillion?: number
  cachedInputPerMillion?: number
  cacheWritePerMillion?: number
  outputPerMillion?: number
}

/** OpenRouter exposes authoritative per-token rates (USD, as strings) on each
 *  model. Convert to per-million. Returns undefined when no usable rate. */
function openRouterPerMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : undefined
}

/** OpenAI's /models lists embeddings, audio, image, moderation, etc. Keep only
 *  chat-capable text models so the picker isn't flooded. */
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|search|babbage|davinci|ada|curie|codex|guard)/i

async function discoverProviderModels(
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; models: DiscoveredModel[]; error?: string }> {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, models: [], error: `Anthropic returned ${res.status}` }
      const data = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string; max_input_tokens?: number }>
      }
      const models = (data.data || []).map((m) => ({
        id: m.id,
        displayName: m.display_name || m.id,
        ...(Number.isFinite(m.max_input_tokens) && (m.max_input_tokens as number) > 0
          ? { contextLength: m.max_input_tokens }
          : {}),
      }))
      return { ok: true, models }
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, models: [], error: `OpenAI returned ${res.status}` }
      const data = (await res.json()) as { data?: Array<{ id: string }> }
      const models = (data.data || [])
        .filter((m) => !OPENAI_NON_CHAT.test(m.id))
        .map((m) => ({ id: m.id, displayName: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, models }
    }
    if (provider === 'openrouter') {
      // OpenRouter's /models is public; send the key only when present so
      // user-specific pricing/limits apply, but discovery works without one.
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, models: [], error: `OpenRouter returned ${res.status}` }
      const data = (await res.json()) as {
        data?: Array<{
          id: string
          name?: string
          context_length?: number
          pricing?: {
            prompt?: string
            completion?: string
            input_cache_read?: string
            input_cache_write?: string
          }
        }>
      }
      const models = (data.data || [])
        .map((m) => ({
          id: m.id,
          displayName: m.name || m.id,
          ...(Number.isFinite(m.context_length) && (m.context_length as number) > 0
            ? { contextLength: m.context_length }
            : {}),
          inputPerMillion: openRouterPerMillion(m.pricing?.prompt),
          outputPerMillion: openRouterPerMillion(m.pricing?.completion),
          cachedInputPerMillion: openRouterPerMillion(m.pricing?.input_cache_read),
          cacheWritePerMillion: openRouterPerMillion(m.pricing?.input_cache_write),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
      return { ok: true, models }
    }
    return { ok: false, models: [], error: `unsupported provider: ${provider}` }
  } catch (err: any) {
    return { ok: false, models: [], error: `Cannot reach ${provider}: ${err?.message || err}` }
  }
}

/** Best-effort family/tier inference from a provider model id, so discovered
 *  models slot into the same billing/labeling buckets as catalog models. */
function inferFamily(provider: string, id: string): string {
  const lower = id.toLowerCase()
  if (provider === 'anthropic' || provider === 'openrouter') {
    if (lower.includes('opus')) return 'opus'
    if (lower.includes('sonnet')) return 'sonnet'
    if (lower.includes('haiku')) return 'haiku'
    if (lower.includes('gpt') || lower.includes('openai/')) return 'gpt'
    return 'other'
  }
  if (provider === 'openai') return 'gpt'
  return 'other'
}

/**
 * Router for super-admin model + provider management. Mount under
 * `/api/admin/settings`.
 */
export function adminModelCatalogRoutes() {
  const router = new Hono()

  // GET /provider-keys — masked native provider keys + how each is configured.
  router.get('/provider-keys', async (c) => {
    const keys: Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }> = {}
    for (const provider of SUPPORTED_NATIVE_PROVIDERS) {
      keys[provider] = getNativeProviderKeyInfoSync(provider)
    }
    return c.json({ keys })
  })

  // PUT /provider-keys — encrypt + store native provider keys (PlatformSetting).
  // Body: a map keyed by provider id, e.g. `{ openai: 'sk-…', anthropic: '' }`.
  // Empty string / null clears the stored override (env fallback then applies).
  router.put('/provider-keys', async (c) => {
    try {
      const body = (await c.req.json<Record<string, string | null | undefined>>()) ?? {}
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const updates: Array<[string, string | null]> = []
      for (const [provider, value] of Object.entries(body)) {
        if (!isNativeProvider(provider)) continue
        if (value === undefined) continue
        updates.push([provider, value === '' ? null : value])
      }
      // If any non-clear value is present, the master key must be configured.
      if (updates.some(([, v]) => v !== null) && !isSecretCryptoConfigured()) {
        return c.json({ error: 'SECRETS_ENCRYPTION_KEY is not configured on this server; cannot store provider keys.' }, 503)
      }
      for (const [provider, value] of updates) {
        await setNativeProviderKey(provider, value, userId)
      }
      await invalidateModelRegistry()

      const keys: Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }> = {}
      for (const provider of SUPPORTED_NATIVE_PROVIDERS) {
        keys[provider] = getNativeProviderKeyInfoSync(provider)
      }
      return c.json({ ok: true, keys })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // GET /providers/:provider/models — live discovery for anthropic / openai /
  // openrouter. OpenRouter's catalog is public, so it lists without a key.
  router.get('/providers/:provider/models', async (c) => {
    const provider = c.req.param('provider')
    if (!DISCOVERY_PROVIDERS.has(provider)) {
      return c.json({ ok: false, models: [], error: 'unsupported provider' }, 400)
    }
    const apiKey = getNativeProviderApiKeySync(provider)
    if (!apiKey && provider !== 'openrouter') {
      return c.json({ ok: false, models: [], error: `No API key configured for ${provider}.` })
    }
    const result = await discoverProviderModels(provider, apiKey || '')
    if (!result.ok) return c.json(result)

    // Enrich with per-token pricing so the admin sees the rate that will be
    // persisted, not $0. OpenRouter ships authoritative rates on each model;
    // for everything else (and any OpenRouter model missing a rate) resolve via
    // the LiteLLM catalog, falling back to the per-family bucket.
    const models = await Promise.all(
      result.models.map(async (m) => {
        if (typeof m.inputPerMillion === 'number' || typeof m.outputPerMillion === 'number') {
          return {
            ...m,
            inputPerMillion: m.inputPerMillion ?? 0,
            cachedInputPerMillion: m.cachedInputPerMillion ?? 0,
            cacheWritePerMillion: m.cacheWritePerMillion ?? 0,
            outputPerMillion: m.outputPerMillion ?? 0,
          }
        }
        const pricing = await resolveEnablePricing(m.id)
        return {
          ...m,
          contextLength: m.contextLength ?? pricing.contextWindow,
          inputPerMillion: pricing.inputPerMillion,
          cachedInputPerMillion: pricing.cachedInputPerMillion,
          cacheWritePerMillion: pricing.cacheWritePerMillion,
          outputPerMillion: pricing.outputPerMillion,
        }
      }),
    )
    return c.json({ ok: true, models })
  })

  // POST /providers/:provider/models/enable — persist which discovered models
  // are enabled as `model_definitions` rows. Body: `{ models: [{ id,
  // displayName?, contextWindow?, enabled }] }`. Enabling upserts a row;
  // disabling flips `enabled: false` (the row is kept so pricing/edits stick).
  router.post('/providers/:provider/models/enable', async (c) => {
    try {
      const provider = c.req.param('provider')
      if (!DISCOVERY_PROVIDERS.has(provider)) {
        return c.json({ error: 'unsupported provider' }, 400)
      }
      const body = await c.req.json()
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      const items = Array.isArray(body?.models) ? body.models : []
      for (const item of items) {
        // The discovered `id` is the upstream provider slug (e.g.
        // `gpt-5-mini`). It becomes the row's `apiModel`, NOT its primary key:
        // the canonical id is a generated UUID so billing/routing key on an
        // opaque id while the slug stays addressable via `aliases`.
        const apiModel = typeof item?.id === 'string' ? item.id.trim() : ''
        if (!apiModel) continue
        const enabled = item?.enabled !== false
        const displayName = typeof item?.displayName === 'string' && item.displayName.trim()
          ? item.displayName.trim()
          : apiModel
        const contextWindow = sanitizeContextWindow(item?.contextWindow)
        const family = inferFamily(provider, apiModel)

        // Match on (provider, apiModel) since the id is now an opaque UUID.
        const existing = await (prisma as any).modelDefinition.findFirst({
          where: { provider, apiModel },
        })
        if (existing) {
          await (prisma as any).modelDefinition.update({
            where: { id: existing.id },
            data: {
              enabled,
              ...(contextWindow ? { contextWindow } : {}),
              updatedBy: userId,
            },
          })
        } else if (enabled) {
          // Auto-fill per-token pricing + context window from the LiteLLM
          // catalog (falling back to the per-family bucket) so the model is
          // never billed at $0. The daily refresh keeps these current.
          const pricing = await resolveEnablePricing(apiModel)
          const effectiveContextWindow = contextWindow ?? pricing.contextWindow ?? null
          await (prisma as any).modelDefinition.create({
            data: {
              id: crypto.randomUUID(),
              provider,
              apiModel,
              displayName,
              shortDisplayName: displayName,
              tier: 'standard',
              family,
              generation: 'current',
              maxOutputTokens: 64000,
              enabled: true,
              // Keep the provider slug addressable so existing references that
              // stored it (and human admins) still resolve to this row.
              aliases: [apiModel],
              ...(effectiveContextWindow ? { contextWindow: effectiveContextWindow } : {}),
              inputPerMillion: pricing.inputPerMillion,
              cachedInputPerMillion: pricing.cachedInputPerMillion,
              cacheWritePerMillion: pricing.cacheWritePerMillion,
              outputPerMillion: pricing.outputPerMillion,
              updatedBy: userId,
            },
          })
        }
      }
      await invalidateModelRegistry()
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // GET /pricing/status — when token prices were last refreshed from LiteLLM.
  router.get('/pricing/status', async (c) => {
    try {
      const [refreshedAt, stale] = await Promise.all([getPricingRefreshedAt(), isPricingStale()])
      return c.json({ refreshedAt, stale })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /pricing/refresh — pull the latest LiteLLM rate card and update pricing
  // + context window on matching model_definitions. `force` refreshes even when
  // fresh; otherwise it only refreshes when the daily TTL has elapsed (so the
  // AI page can fire this on load without hammering GitHub).
  router.post('/pricing/refresh', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const force = body?.force === true
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'

      if (!force && !(await isPricingStale())) {
        return c.json({ ok: true, skipped: true, refreshedAt: await getPricingRefreshedAt(), updated: 0, total: 0 })
      }
      const result = await refreshModelPricingFromLiteLLM(userId)
      if (result.ok) await invalidateModelRegistry()
      return c.json(result)
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

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

      // The canonical id is always a generated UUID — the upstream provider
      // slug lives in `apiModel` (and as an alias). Any client-supplied `id`
      // is ignored so billing/routing key on an opaque, stable identifier.
      const id = crypto.randomUUID()
      const provider = typeof body?.provider === 'string' ? body.provider : ''
      const apiModel = typeof body?.apiModel === 'string' ? body.apiModel.trim() : ''
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
      const shortDisplayName = typeof body?.shortDisplayName === 'string' && body.shortDisplayName.trim()
        ? body.shortDisplayName.trim()
        : displayName

      if (!MODEL_PROVIDERS.has(provider)) return c.json({ error: 'invalid provider' }, 400)
      if (!apiModel) return c.json({ error: 'apiModel is required' }, 400)
      if (!displayName) return c.json({ error: 'displayName is required' }, 400)

      const tier = MODEL_TIERS.has(body?.tier) ? body.tier : 'standard'
      const family = MODEL_FAMILIES.has(body?.family) ? body.family : 'other'
      const generation = MODEL_GENERATIONS.has(body?.generation) ? body.generation : 'current'
      const maxOutputTokens = Number.isFinite(body?.maxOutputTokens) && body.maxOutputTokens > 0
        ? Math.floor(body.maxOutputTokens)
        : 64000

      if (body?.reasoningEffort != null && !MODEL_REASONING_EFFORTS.has(body.reasoningEffort)) {
        return c.json({ error: 'invalid reasoningEffort' }, 400)
      }
      const description = typeof body?.description === 'string' && body.description.trim()
        ? body.description.trim()
        : null
      const reasoningEffort = MODEL_REASONING_EFFORTS.has(body?.reasoningEffort) ? body.reasoningEffort : null

      // Fill pricing + context window from the LiteLLM catalog (then per-family
      // bucket) for any field the admin didn't supply, so a manually-added
      // model is never billed at $0 and carries a context window.
      // Look up pricing by the provider slug — `id` is now an opaque UUID, so
      // both the LiteLLM match and the family-bucket fallback must key on
      // `apiModel`.
      const litellm = await resolveEnablePricing(apiModel, apiModel)
      const pickPrice = (raw: unknown, fallback: number) =>
        raw != null ? sanitizePrice(raw) : fallback
      const contextWindow = sanitizeContextWindow(body?.contextWindow) ?? litellm.contextWindow ?? null

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
          // Keep the provider slug addressable alongside any admin-supplied
          // aliases so the UUID id stays resolvable by its human-readable name.
          aliases: Array.from(new Set([...sanitizeAliases(body?.aliases), apiModel])),
          capabilities: body?.capabilities && typeof body.capabilities === 'object' ? body.capabilities : null,
          description,
          contextWindow,
          reasoningEffort,
          inputPerMillion: pickPrice(body?.inputPerMillion, litellm.inputPerMillion),
          cachedInputPerMillion: pickPrice(body?.cachedInputPerMillion, litellm.cachedInputPerMillion),
          cacheWritePerMillion: pickPrice(body?.cacheWritePerMillion, litellm.cacheWritePerMillion),
          outputPerMillion: pickPrice(body?.outputPerMillion, litellm.outputPerMillion),
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
      if ('description' in (body ?? {})) {
        data.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
      }
      if ('contextWindow' in (body ?? {})) {
        data.contextWindow = sanitizeContextWindow(body.contextWindow)
      }
      if ('reasoningEffort' in (body ?? {})) {
        if (body.reasoningEffort != null && !MODEL_REASONING_EFFORTS.has(body.reasoningEffort)) {
          return c.json({ error: 'invalid reasoningEffort' }, 400)
        }
        data.reasoningEffort = MODEL_REASONING_EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : null
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
