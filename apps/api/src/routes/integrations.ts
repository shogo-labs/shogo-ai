// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integrations Routes - Composio-powered OAuth integrations
 *
 * Only COMPOSIO_API_KEY is required. Composio provides managed OAuth
 * credentials for all toolkits by default. Any toolkit name that Composio
 * supports can be used — no server-side allowlist needed. Optional
 * COMPOSIO_*_AUTH_CONFIG env vars enable white-labeling for specific
 * toolkits (consent screens show your app name instead of Composio's).
 *
 * Endpoints:
 * - GET    /integrations/providers       - List available Composio-backed providers
 * - POST   /integrations/connect         - Initiate OAuth connection for a toolkit
 * - GET    /integrations/connections      - List user's connected accounts
 * - DELETE /integrations/connections/:id  - Disconnect an account
 * - GET    /integrations/status/:toolkit  - Check connection status for a toolkit
 */

import { Hono } from 'hono'
import { Composio } from '@composio/core'

// =============================================================================
// Cloud forwarding for local mode with SHOGO_API_KEY
// =============================================================================

const CLOUD_SKIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'cookie',
])

function getShogoCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai').replace(/\/$/, '')
}

function shouldForwardToCloud(): boolean {
  return !!process.env.SHOGO_API_KEY
}

async function forwardIntegrationsToCloud(
  method: string,
  path: string,
  originalReq: Request,
  body?: string | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const cloudUrl = getShogoCloudUrl()
  const shogoKey = process.env.SHOGO_API_KEY!
  const url = `${cloudUrl}/api/${path}`

  const headers = new Headers()
  originalReq.headers.forEach((value, key) => {
    if (!CLOUD_SKIP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  headers.set('Authorization', `Bearer ${shogoKey}`)
  if (body) headers.set('Content-Type', 'application/json')
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
  }

  const upstream = await fetch(url, { method, headers, body })

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'content-encoding' || lower === 'transfer-encoding') return
    responseHeaders.set(key, value)
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

function extractRedirectFromCallbackUrl(callbackUrl: string): string | null {
  try {
    const parsed = new URL(callbackUrl)
    return parsed.searchParams.get('redirect')
  } catch {
    return null
  }
}

function buildCloudCallbackUrl(redirectParam?: string | null): string {
  const cloudUrl = getShogoCloudUrl()
  const base = `${cloudUrl}/api/integrations/callback`
  const redirect = redirectParam || 'shogo://integrations-callback'
  return `${base}?redirect=${encodeURIComponent(redirect)}`
}

// =============================================================================
// Auth config overrides
// =============================================================================

const TOOLKIT_AUTH_CONFIG_OVERRIDES: Record<string, string> = {}

/**
 * Load optional Composio auth config overrides from environment variables.
 *
 * Without these overrides Composio uses its shared default OAuth apps, which
 * request a very broad set of scopes (e.g. 28+ Slack scopes). Set these env
 * vars to a custom Composio auth config ID to restrict scopes to only what
 * the integration actually needs:
 *
 *   COMPOSIO_SLACK_AUTH_CONFIG  — create in Composio dashboard with scopes:
 *     chat:write, channels:read, channels:write, im:write, users:read
 *   COMPOSIO_GOOGLE_AUTH_CONFIG — covers googlecalendar, gmail, googledrive
 *   COMPOSIO_GITHUB_AUTH_CONFIG — covers github
 *   COMPOSIO_LINEAR_AUTH_CONFIG — covers linear
 *   COMPOSIO_NOTION_AUTH_CONFIG — covers notion
 *   COMPOSIO_STRIPE_AUTH_CONFIG — covers stripe
 *
 * Adding a new toolkit requires no code changes here — just set the env var.
 */
function loadAuthConfigs() {
  const envMap: Record<string, string[]> = {
    COMPOSIO_GOOGLE_AUTH_CONFIG: ['googlecalendar', 'gmail', 'googledrive'],
    COMPOSIO_SLACK_AUTH_CONFIG: ['slack'],
    COMPOSIO_GITHUB_AUTH_CONFIG: ['github'],
    COMPOSIO_LINEAR_AUTH_CONFIG: ['linear'],
    COMPOSIO_NOTION_AUTH_CONFIG: ['notion'],
    COMPOSIO_STRIPE_AUTH_CONFIG: ['stripe'],
  }

  const missing: string[] = []
  for (const [envKey, toolkits] of Object.entries(envMap)) {
    const value = process.env[envKey]
    if (value) {
      for (const toolkit of toolkits) {
        TOOLKIT_AUTH_CONFIG_OVERRIDES[toolkit] = value
      }
    } else {
      missing.push(envKey)
    }
  }

  if (missing.length > 0) {
    console.warn(
      `[Integrations] No custom auth config for: ${missing.join(', ')}. ` +
      'Composio default OAuth apps will be used (broad scopes). ' +
      'Set these env vars to a Composio auth config ID to restrict OAuth scopes.'
    )
  }
}

let composioClient: Composio | null = null

function getComposio(): Composio | null {
  if (composioClient) return composioClient
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) return null
  composioClient = new Composio({ apiKey })
  return composioClient
}

function buildComposioUserId(userId: string, workspaceId: string, projectId: string): string {
  return `shogo_${userId}_${workspaceId}_${projectId}`
}

/** TODO: Remove after all existing connections have been re-authenticated under the new format. */
function buildLegacyComposioUserId(userId: string, projectId: string): string {
  return `shogo_${userId}_${projectId}`
}

async function getProjectWorkspaceId(projectId: string): Promise<string | null> {
  try {
    const { prisma } = await import('../lib/prisma')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    return project?.workspaceId ?? null
  } catch {
    return null
  }
}

export function integrationRoutes() {
  loadAuthConfigs()

  const router = new Hono()

  router.get('/integrations/providers', async (c) => {
    if (shouldForwardToCloud()) {
      return forwardIntegrationsToCloud('GET', 'integrations/providers', c.req.raw)
    }

    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: [], enabled: false })
    }

    try {
      const toolkits = await composio.toolkits.get()
      const providers = toolkits.map((toolkit: any) => ({
        toolkit: toolkit.slug,
        name: toolkit.name,
        whiteLabeled: !!TOOLKIT_AUTH_CONFIG_OVERRIDES[toolkit.slug],
        available: true,
      }))
      return c.json({ ok: true, data: providers, enabled: true })
    } catch (err: any) {
      console.error('[Integrations] Failed to list providers:', err.message)
      return c.json({ ok: true, data: [], enabled: true })
    }
  })

  router.post('/integrations/connect', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json() as {
      toolkit: string
      projectId: string
      callbackUrl?: string
    }

    const { toolkit, projectId, callbackUrl } = body

    if (!toolkit || !projectId) {
      return c.json({ error: 'toolkit and projectId are required' }, 400)
    }

    if (shouldForwardToCloud()) {
      const redirectParam = callbackUrl ? extractRedirectFromCallbackUrl(callbackUrl) : null
      const cloudCallbackUrl = buildCloudCallbackUrl(redirectParam)

      return forwardIntegrationsToCloud(
        'POST',
        'integrations/connect',
        c.req.raw,
        JSON.stringify({ toolkit, projectId, callbackUrl: cloudCallbackUrl }),
      )
    }

    const composio = getComposio()
    if (!composio) {
      return c.json({ error: 'Composio integration not configured' }, 503)
    }

    if (callbackUrl) {
      try {
        const parsed = new URL(callbackUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return c.json({ error: 'callbackUrl must use http or https protocol' }, 400)
        }
      } catch {
        return c.json({ error: 'callbackUrl must be a valid URL' }, 400)
      }
    }

    const workspaceId = auth.workspaceId || await getProjectWorkspaceId(projectId) || 'default'
    const composioUserId = buildComposioUserId(auth.userId, workspaceId, projectId)
    const authConfigOverride = TOOLKIT_AUTH_CONFIG_OVERRIDES[toolkit]

    try {
      const sessionOpts = authConfigOverride
        ? { authConfigs: { [toolkit]: authConfigOverride } }
        : undefined
      const session = await composio.create(composioUserId, sessionOpts)

      const connection = await session.authorize(toolkit, {
        callbackUrl: callbackUrl || `${process.env.BETTER_AUTH_URL || ''}/api/integrations/callback`,
      })

      return c.json({
        ok: true,
        data: {
          redirectUrl: connection.redirectUrl,
          connectionId: connection.id,
          status: connection.status,
          toolkit,
        },
      })
    } catch (err: any) {
      console.error(`[Integrations] Connect error for ${toolkit}:`, err.message)
      return c.json({ error: 'Failed to create integration connection' }, 500)
    }
  })

  // Note: GET /integrations/callback is registered directly on the app
  // (before auth middleware) in server.ts to avoid auth blocking.

  router.get('/integrations/connections', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.query('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId query parameter required' }, 400)
    }

    if (shouldForwardToCloud()) {
      return forwardIntegrationsToCloud(
        'GET',
        `integrations/connections?projectId=${encodeURIComponent(projectId)}`,
        c.req.raw,
      )
    }

    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: [] })
    }

    const workspaceId = auth.workspaceId || await getProjectWorkspaceId(projectId) || 'default'
    const composioUserId = buildComposioUserId(auth.userId, workspaceId, projectId)
    // TODO: Remove legacy ID lookup after all connections migrated to new format
    const legacyId = buildLegacyComposioUserId(auth.userId, projectId)
    const userIds = legacyId !== composioUserId ? [composioUserId, legacyId] : [composioUserId]

    try {
      const accounts = await composio.connectedAccounts.list({ userIds })

      const items = (accounts as any)?.items || (accounts as any)?.data || []

      const connections = items.map((acc: any) => {
        const stateVal = acc.state?.val ?? acc.connectionParams ?? {}
        const accountIdentifier =
          stateVal.account_id ??
          stateVal.user_email ??
          stateVal.email ??
          acc.memberEmailId ??
          acc.metadata?.email ??
          null
        return {
          id: acc.id,
          toolkit: acc.toolkit?.slug ?? acc.appName ?? acc.app_name ?? 'unknown',
          status: acc.status,
          statusReason: acc.statusReason ?? acc.status_reason ?? null,
          createdAt: acc.createdAt || acc.created_at,
          accountIdentifier,
        }
      })

      return c.json({ ok: true, data: connections })
    } catch (err: any) {
      console.error(`[Integrations] List connections error for user ${composioUserId}:`, err.message)
      return c.json({ ok: true, data: [] })
    }
  })

  router.delete('/integrations/connections/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const connectionId = c.req.param('id')

    if (shouldForwardToCloud()) {
      return forwardIntegrationsToCloud('DELETE', `integrations/connections/${connectionId}`, c.req.raw)
    }

    const composio = getComposio()
    if (!composio) {
      return c.json({ error: 'Composio integration not configured' }, 503)
    }

    try {
      await composio.connectedAccounts.delete(connectionId)
      return c.json({ ok: true })
    } catch (err: any) {
      console.error(`[Integrations] Disconnect error:`, err.message)
      return c.json({ error: 'Failed to disconnect integration' }, 500)
    }
  })

  router.get('/integrations/status/:toolkit', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const toolkit = c.req.param('toolkit')
    const projectId = c.req.query('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId query parameter required' }, 400)
    }

    if (shouldForwardToCloud()) {
      return forwardIntegrationsToCloud(
        'GET',
        `integrations/status/${encodeURIComponent(toolkit)}?projectId=${encodeURIComponent(projectId)}`,
        c.req.raw,
      )
    }

    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: { connected: false, enabled: false } })
    }

    const workspaceId = auth.workspaceId || await getProjectWorkspaceId(projectId) || 'default'
    // TODO: Remove legacy ID lookups after all connections migrated to new format
    const candidateIds = [
      buildComposioUserId(auth.userId, workspaceId, projectId),
      buildComposioUserId('default', workspaceId, projectId),
      buildLegacyComposioUserId(auth.userId, projectId),
      buildLegacyComposioUserId('default', projectId),
    ]
    const uniqueIds = [...new Set(candidateIds)]

    try {
      const accounts = await composio.connectedAccounts.list({
        userIds: uniqueIds,
      })

      const items = (accounts as any)?.items || (accounts as any)?.data || []
      const match = items.find((acc: any) => {
        const raw = acc.toolkit?.slug ?? acc.appName ?? acc.app_name ?? ''
        const accToolkit = typeof raw === 'string' ? raw : String(raw)
        return accToolkit.toLowerCase() === toolkit.toLowerCase()
      })

      const isActive = match?.status === 'ACTIVE' || match?.status === 'active'

      return c.json({
        ok: true,
        data: {
          connected: !!match && isActive,
          status: match?.status || null,
          connectionId: match?.id || null,
          enabled: true,
        },
      })
    } catch (err: any) {
      console.error(`[Integrations] Status check error for ${toolkit}:`, err.message)
      return c.json({ ok: true, data: { connected: false, status: null, connectionId: null, enabled: true } })
    }
  })

  return router
}
