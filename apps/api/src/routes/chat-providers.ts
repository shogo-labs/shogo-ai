// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat on external providers: webhook ingress for Teams and Google Chat
 * (Slack keeps /integrations/slack/events), connect codes, account links,
 * and disconnecting an install.
 */

import { Hono } from 'hono'
import { EXTERNAL_CHAT_PROVIDERS, getWorkspaceChatConfig, setWorkspaceChatConfig, type ExternalChatProvider } from '../services/chat-mode'
import { getWorkspaceRole } from '../services/conversation.service'
import { handleInboundEvents, resumeAfterLinkInHomeRegion, routeInboundEvents } from '../services/chat-providers/inbound'
import { installationForTenant, linkIdentity, removeInstallation } from '../services/chat-providers/installations'
import { createConnectCode, verifyLinkState } from '../services/chat-providers/link'
import { getChatProvider } from '../services/chat-providers/registry'

export interface ChatProviderRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

const WEBHOOK_PROVIDERS = new Set<ExternalChatProvider>(['teams', 'google_chat'])

function isProvider(value: string): value is ExternalChatProvider {
  return (EXTERNAL_CHAT_PROVIDERS as readonly string[]).includes(value)
}

export function chatProviderRoutes(config: ChatProviderRoutesConfig): Hono {
  const router = new Hono()

  router.post('/chat-providers/:provider/events', async (c) => {
    const kind = c.req.param('provider')
    const provider = isProvider(kind) && WEBHOOK_PROVIDERS.has(kind) ? getChatProvider(kind) : null
    if (!provider) return c.json({ error: 'Unknown chat provider' }, 404)
    const rawBody = await c.req.text()
    const parsed = await provider.verifyAndParse(c.req.raw, rawBody)
    if (parsed.response) return parsed.response
    // Events for a workspace homed in a peer region are forwarded there; if that
    // region is unreachable, answer 503 so the platform redelivers.
    const routed = await routeInboundEvents(provider, parsed.events)
    if (routed.unavailable) return c.json({ error: 'Home region unavailable, retry' }, 503)
    // Both platforms expect a fast acknowledgement; agent turns can run long.
    void handleInboundEvents(provider, routed.local).catch((err) => {
      console.error(`[ChatProviders] ${kind} events failed:`, err)
    })
    return c.json({})
  })

  // Called by the /auth/chat-link page with the signed-in user's session.
  router.post('/chat-providers/link', async (c) => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in to link your account' } }, 401)
    const body = await c.req.json().catch(() => ({} as any))
    const state = verifyLinkState(typeof body.state === 'string' ? body.state : null)
    if (!state) return c.json({ error: { code: 'invalid_state', message: 'This link has expired. Ask again from chat.' } }, 400)
    const installation = await installationForTenant(state.provider, state.tenantId)
    if (!installation) return c.json({ error: { code: 'not_installed', message: 'That chat workspace is not connected to Shogo' } }, 404)
    if (!(await getWorkspaceRole(installation.workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'You are not a member of the connected Shogo workspace' } }, 403)
    }
    await linkIdentity({
      provider: state.provider,
      externalTenantId: state.tenantId,
      externalUserId: state.externalUserId,
      userId,
      displayName: state.displayName,
    })
    const provider = getChatProvider(state.provider)
    const resumed = provider && state.channelId && state.messageId
      ? await resumeAfterLinkInHomeRegion(provider, { tenantId: state.tenantId, channelId: state.channelId, messageId: state.messageId }, userId)
      : false
    return c.json({ ok: true, provider: state.provider, resumed })
  })

  const requireAdmin = async (c: any): Promise<{ userId: string; workspaceId: string; provider: ExternalChatProvider } | Response> => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401)
    const workspaceId = c.req.param('workspaceId')
    const provider = c.req.param('provider')
    if (!isProvider(provider)) return c.json({ error: { code: 'invalid_provider', message: 'Unknown chat provider' } }, 400)
    const role = await getWorkspaceRole(workspaceId, userId)
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ error: { code: 'forbidden', message: 'Only workspace admins can manage chat apps' } }, 403)
    }
    return { userId, workspaceId, provider }
  }

  router.post('/workspaces/:workspaceId/chat-installations/:provider/connect-code', async (c) => {
    const ctx = await requireAdmin(c)
    if (ctx instanceof Response) return ctx
    if (!WEBHOOK_PROVIDERS.has(ctx.provider)) {
      return c.json({ error: { code: 'unsupported', message: 'Slack connects with its own install button' } }, 400)
    }
    const { code, expiresAt } = createConnectCode(ctx)
    return c.json({ code, expiresAt, command: `@Shogo connect ${code}` })
  })

  router.delete('/workspaces/:workspaceId/chat-installations/:provider', async (c) => {
    const ctx = await requireAdmin(c)
    if (ctx instanceof Response) return ctx
    const current = await getWorkspaceChatConfig(ctx.workspaceId)
    if (current.provider === ctx.provider) await setWorkspaceChatConfig(ctx.workspaceId, { mode: 'native' })
    await removeInstallation(ctx.workspaceId, ctx.provider)
    return c.json({ ok: true })
  })

  return router
}
