// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-only system routes extracted from the cloud API composer.
 *
 * Keeping these routes in a local module lets the desktop entry point avoid
 * loading the cloud billing/admin/marketplace route graph while preserving the
 * local setup, provider-key, and diagnostics contract.
 */
import { Hono } from 'hono'
import os from 'node:os'
import { auth } from '../auth'
import { prisma } from '../lib/prisma'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  _resetAgentModelDefaultsCache,
  _resetUpstreamCredentialCache,
} from '../lib/federated-upstream'

const PROVIDER_KEYS = [
  { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'openai', envKey: 'OPENAI_API_KEY' },
  { id: 'google', envKey: 'GOOGLE_API_KEY' },
  { id: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
] as const

const PROVIDER_BY_ID = new Map(PROVIDER_KEYS.map((p) => [p.id, p.envKey]))
const ALL_PROVIDER_ENV_KEYS = PROVIDER_KEYS.map((p) => p.envKey)
const LEGACY_BODY_ALIASES: Record<string, string> = {
  anthropicApiKey: 'anthropic',
  openaiApiKey: 'openai',
  googleApiKey: 'google',
}

const LLM_CONFIG_KEYS = [
  'AI_MODE',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_BASIC_MODEL',
  'LOCAL_LLM_ADVANCED_MODEL',
  'LOCAL_EMBEDDING_MODEL',
  'LOCAL_EMBEDDING_DIMENSIONS',
  'IMAGE_GEN_PROVIDER',
  'LOCAL_IMAGE_GEN_BASE_URL',
  'LOCAL_IMAGE_GEN_MODEL',
]

export function localSystemRoutes(): Hono {
  const router = new Hono()
  const localDb = prisma as any

  router.post('/local/auto-sign-in', async (c) => {
    try {
      const user = await prisma.user.findFirst()
      if (!user) {
        return c.json({ ok: false, error: 'No local user found. Server may still be initializing.' }, 503)
      }
      const storedPw = await localDb.localConfig.findUnique({ where: { key: 'local_user_password' } })
      if (!storedPw) return c.json({ ok: false, error: 'Local user password not found in config.' }, 500)
      return auth.api.signInEmail({
        body: { email: user.email, password: storedPw.value },
        headers: c.req.raw.headers,
        asResponse: true,
      })
    } catch (err: any) {
      console.error('[LocalMode] Auto-sign-in failed:', err)
      return c.json({ ok: false, error: err?.message || String(err) }, 500)
    }
  })

  router.get('/local/api-keys', async (c) => {
    try {
      const rows = await localDb.localConfig.findMany({
        where: { key: { in: ALL_PROVIDER_ENV_KEYS } },
      })
      const byEnvKey = new Map<string, string>(rows.map((row: any) => [String(row.key), String(row.value)]))
      const keys: Record<string, string> = {}
      for (const provider of PROVIDER_KEYS) {
        const value = byEnvKey.get(provider.envKey)
        if (value) keys[provider.id] = value.slice(0, 8) + '...' + value.slice(-4)
      }
      return c.json({ ok: true, keys })
    } catch {
      return c.json({ ok: true, keys: {} })
    }
  })

  router.put('/local/api-keys', async (c) => {
    const body = (await c.req.json<Record<string, string | null | undefined>>()) ?? {}
    const updates = new Map<string, string | null>()
    for (const [field, value] of Object.entries(body)) {
      const providerId = LEGACY_BODY_ALIASES[field] ?? field
      if (!PROVIDER_BY_ID.has(providerId as any) || value === undefined) continue
      updates.set(providerId, value === '' ? null : value)
    }
    await Promise.all([...updates].map(async ([providerId, value]) => {
      const key = PROVIDER_BY_ID.get(providerId as (typeof PROVIDER_KEYS)[number]['id'])!
      if (value) {
        await localDb.localConfig.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
        process.env[key] = value
      } else {
        await localDb.localConfig.deleteMany({ where: { key } })
        delete process.env[key]
      }
    }))
    _resetUpstreamCredentialCache()
    _resetAgentModelDefaultsCache()
    return c.json({ ok: true })
  })

  router.get('/local/llm-config', async (c) => {
    try {
      const rows = await localDb.localConfig.findMany({ where: { key: { in: LLM_CONFIG_KEYS } } })
      const config: Record<string, string> = {}
      for (const row of rows) config[row.key] = row.value
      return c.json({ ok: true, config })
    } catch {
      return c.json({ ok: true, config: {} })
    }
  })

  router.put('/local/llm-config', async (c) => {
    const body = await c.req.json<Record<string, string | null>>()
    await Promise.all(Object.entries(body).map(async ([key, value]) => {
      if (!LLM_CONFIG_KEYS.includes(key)) return
      if (value) {
        await localDb.localConfig.upsert({ where: { key }, update: { value }, create: { key, value } })
        process.env[key] = value
      } else {
        await localDb.localConfig.deleteMany({ where: { key } })
        delete process.env[key]
      }
    }))
    return c.json({ ok: true })
  })

  router.get('/local/openrouter/models', async (c) => {
    const key = process.env.OPENROUTER_API_KEY
    const baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) return c.json({ ok: false, error: `OpenRouter returned ${response.status}`, models: [] })
      const data = await response.json() as { data?: Array<{ id: string; name?: string; description?: string; context_length?: number }> }
      return c.json({
        ok: true,
        models: (data.data ?? []).map((model) => ({
          id: model.id,
          name: model.name || model.id,
          description: model.description,
          contextLength: model.context_length,
        })),
      })
    } catch (err: any) {
      return c.json({ ok: false, error: `Cannot reach OpenRouter: ${err?.message ?? err}`, models: [] })
    }
  })

  router.get('/local/models', async (c) => {
    const baseUrl = process.env.LOCAL_LLM_BASE_URL
    if (!baseUrl) return c.json({ ok: false, error: 'No LLM base URL configured.', models: [] })
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return c.json({ ok: false, error: `LLM server returned ${response.status}`, models: [] })
      const data = await response.json() as { data?: Array<{ id: string }> }
      return c.json({ ok: true, models: (data.data ?? []).map((model) => ({ id: model.id, name: model.id })) })
    } catch (err: any) {
      return c.json({ ok: false, error: `Cannot reach LLM server: ${err?.message ?? err}`, models: [] })
    }
  })

  router.get('/local/security-prefs', async (c) => {
    try {
      const row = await localDb.localConfig.findUnique({ where: { key: 'SECURITY_PREFS' } })
      return c.json(row ? JSON.parse(row.value) : { mode: 'full_autonomy', approvalTimeoutSeconds: 60 })
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500)
    }
  })

  router.post('/local/security-prefs', async (c) => {
    try {
      const body = await c.req.json()
      if (body.mode && !['strict', 'balanced', 'full_autonomy'].includes(body.mode)) {
        return c.json({ error: 'Invalid security mode' }, 400)
      }
      const value = JSON.stringify(body)
      await localDb.localConfig.upsert({
        where: { key: 'SECURITY_PREFS' },
        update: { value },
        create: { key: 'SECURITY_PREFS', value },
      })
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 500)
    }
  })

  router.get('/local/shogo-key', async (c) => {
    const row = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_API_KEY' } }).catch(() => null)
    const infoRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_KEY_INFO' } }).catch(() => null)
    if (!row) return c.json({ connected: false, cloudUrl: getShogoCloudUrl() })
    let info: unknown = null
    try { info = infoRow ? JSON.parse(infoRow.value) : null } catch {}
    return c.json({
      connected: true,
      keyMask: row.value.slice(0, 17) + '...' + row.value.slice(-4),
      cloudUrl: getShogoCloudUrl(),
      workspace: (info as any)?.workspace || null,
    })
  })

  router.put('/local/shogo-key', async (c) => {
    const body = await c.req.json<{ key: string }>()
    if (!body.key?.startsWith('shogo_sk_')) {
      return c.json({ ok: false, error: 'Invalid key format. Keys start with shogo_sk_' }, 400)
    }
    const cloudUrl = getShogoCloudUrl()
    try {
      const response = await fetch(`${cloudUrl}/api/api-keys/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: body.key }),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await response.json().catch(() => ({ valid: false, error: `HTTP ${response.status}` }))
      if (!response.ok || !data.valid) {
        return c.json({ ok: false, error: data.error || 'Key validation failed', cloudUrl }, 400)
      }
      const info = JSON.stringify({ workspace: data.workspace, user: data.user })
      await Promise.all([
        localDb.localConfig.upsert({
          where: { key: 'SHOGO_API_KEY' },
          update: { value: body.key },
          create: { key: 'SHOGO_API_KEY', value: body.key },
        }),
        localDb.localConfig.upsert({
          where: { key: 'SHOGO_KEY_INFO' },
          update: { value: info },
          create: { key: 'SHOGO_KEY_INFO', value: info },
        }),
      ])
      process.env.SHOGO_API_KEY = body.key
      _resetUpstreamCredentialCache()
      _resetAgentModelDefaultsCache()
      return c.json({ ok: true, workspace: data.workspace, cloudUrl })
    } catch (err: any) {
      return c.json({ ok: false, error: `Cannot reach Shogo Cloud: ${err?.message ?? err}`, cloudUrl }, 502)
    }
  })

  router.delete('/local/shogo-key', async (c) => {
    await Promise.all([
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_API_KEY' } }),
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_KEY_INFO' } }),
    ])
    delete process.env.SHOGO_API_KEY
    _resetUpstreamCredentialCache()
    _resetAgentModelDefaultsCache()
    return c.json({ ok: true })
  })

  router.put('/local/instance-name', async (c) => {
    const body = await c.req.json<{ name: string }>()
    const name = body.name?.trim()
    if (!name) return c.json({ ok: false, error: 'Name is required' }, 400)
    await localDb.localConfig.upsert({
      where: { key: 'SHOGO_INSTANCE_NAME' },
      update: { value: name },
      create: { key: 'SHOGO_INSTANCE_NAME', value: name },
    })
    process.env.SHOGO_INSTANCE_NAME = name
    return c.json({ ok: true, name })
  })

  router.get('/local/instance-info', async () => {
    const name = process.env.SHOGO_INSTANCE_NAME || os.hostname()
    return Response.json({
      name,
      hostname: os.hostname(),
      os: os.platform(),
      arch: os.arch(),
      tunnelConnected: false,
      cloudUrl: getShogoCloudUrl(),
    })
  })

  return router
}
