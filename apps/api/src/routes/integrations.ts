// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integrations Routes - Composio-powered OAuth integrations
 *
 * Only COMPOSIO_API_KEY is required. Composio provides managed OAuth
 * credentials for all toolkits by default. Optional COMPOSIO_*_AUTH_CONFIG
 * env vars enable white-labeling (consent screens show your app name).
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

const SUPPORTED_TOOLKITS = [
  'googlecalendar', 'gmail', 'googledrive',
  'slack', 'github', 'linear', 'notion',
] as const

const TOOLKIT_AUTH_CONFIG_OVERRIDES: Record<string, string> = {}

function loadAuthConfigs() {
  const envMap: Record<string, string[]> = {
    COMPOSIO_GOOGLE_AUTH_CONFIG: ['googlecalendar', 'gmail', 'googledrive'],
    COMPOSIO_SLACK_AUTH_CONFIG: ['slack'],
    COMPOSIO_GITHUB_AUTH_CONFIG: ['github'],
    COMPOSIO_LINEAR_AUTH_CONFIG: ['linear'],
    COMPOSIO_NOTION_AUTH_CONFIG: ['notion'],
  }

  for (const [envKey, toolkits] of Object.entries(envMap)) {
    const value = process.env[envKey]
    if (value) {
      for (const toolkit of toolkits) {
        TOOLKIT_AUTH_CONFIG_OVERRIDES[toolkit] = value
      }
    }
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

function buildComposioUserId(userId: string, projectId: string): string {
  return `shogo_${userId}_${projectId}`
}

export function integrationRoutes() {
  loadAuthConfigs()

  const router = new Hono()

  router.get('/integrations/providers', (c) => {
    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: [], enabled: false })
    }

    const providers = SUPPORTED_TOOLKITS.map((toolkit) => ({
      toolkit,
      whiteLabeled: !!TOOLKIT_AUTH_CONFIG_OVERRIDES[toolkit],
      available: true,
    }))

    return c.json({ ok: true, data: providers, enabled: true })
  })

  router.post('/integrations/connect', async (c) => {
    const composio = getComposio()
    if (!composio) {
      return c.json({ error: 'Composio integration not configured' }, 503)
    }

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

    const composioUserId = buildComposioUserId(auth.userId, projectId)
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
    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: [] })
    }

    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.query('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId query parameter required' }, 400)
    }

    const composioUserId = buildComposioUserId(auth.userId, projectId)

    try {
      const accounts = await composio.connectedAccounts.list({
        userIds: [composioUserId],
      })

      const items = (accounts as any)?.items || (accounts as any)?.data || []
      console.log('[Integrations] Raw connected accounts:', JSON.stringify(items, null, 2))

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
          createdAt: acc.createdAt || acc.created_at,
          accountIdentifier,
        }
      })

      return c.json({ ok: true, data: connections })
    } catch (err: any) {
      console.error(`[Integrations] List connections error:`, err.message)
      return c.json({ ok: true, data: [] })
    }
  })

  router.delete('/integrations/connections/:id', async (c) => {
    const composio = getComposio()
    if (!composio) {
      return c.json({ error: 'Composio integration not configured' }, 503)
    }

    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const connectionId = c.req.param('id')

    try {
      await composio.connectedAccounts.delete(connectionId)
      return c.json({ ok: true })
    } catch (err: any) {
      console.error(`[Integrations] Disconnect error:`, err.message)
      return c.json({ error: 'Failed to disconnect integration' }, 500)
    }
  })

  router.get('/integrations/status/:toolkit', async (c) => {
    const composio = getComposio()
    if (!composio) {
      return c.json({ ok: true, data: { connected: false, enabled: false } })
    }

    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const toolkit = c.req.param('toolkit')
    const projectId = c.req.query('projectId')
    if (!projectId) {
      return c.json({ error: 'projectId query parameter required' }, 400)
    }

    // Check both the authenticated user's entity and the 'default' entity.
    // The agent runtime prefers the X-User-Id header from the chat request,
    // falling back to process.env.USER_ID then 'default'.
    const candidateIds = [
      buildComposioUserId(auth.userId, projectId),
      buildComposioUserId('default', projectId),
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
      console.error(`[Integrations] Status check error:`, err.message)
      return c.json({ ok: true, data: { connected: false, enabled: true } })
    }
  })

  return router
}
