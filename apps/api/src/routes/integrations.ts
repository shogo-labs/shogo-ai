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
      return c.json({ error: `Failed to create connection: ${err.message}` }, 500)
    }
  })

  router.get('/integrations/callback', (c) => {
    const callbackStatus = c.req.query('status') || 'success'
    const ok = callbackStatus === 'success'
    const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #333; }
  .card { text-align: center; padding: 2rem; }
  .icon { font-size: 3rem; margin-bottom: 0.5rem; }
  p { font-size: 0.9rem; color: #666; }
</style></head><body>
  <div class="card">
    <div class="icon">${ok ? '✅' : '❌'}</div>
    <h3>${ok ? 'Connected!' : 'Connection failed'}</h3>
    <p>${ok ? 'This window will close automatically...' : 'Please close this window and try again.'}</p>
  </div>
  <script>${ok ? 'setTimeout(function(){ window.close(); }, 1500);' : ''}</script>
</body></html>`
    return c.html(html)
  })

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

      const connections = ((accounts as any)?.items || (accounts as any)?.data || []).map((acc: any) => ({
        id: acc.id,
        toolkit: acc.toolkit?.slug ?? acc.appName ?? acc.app_name ?? 'unknown',
        status: acc.status,
        createdAt: acc.createdAt || acc.created_at,
        accountIdentifier: acc.memberEmailId ?? acc.metadata?.email ?? acc.connectionParams?.user_email ?? null,
      }))

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
      return c.json({ error: `Failed to disconnect: ${err.message}` }, 500)
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
    // The agent runtime uses process.env.USER_ID which may not be set (falls
    // back to 'default'), while the API has the real auth userId.
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
