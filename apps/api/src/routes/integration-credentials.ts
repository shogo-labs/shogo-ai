// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Acts as" settings for integrations, and personal connections.
 *
 * Project-scoped (behind requireProjectAccess):
 * - GET  /projects/:projectId/integrations/policies            - policies + what the caller has connected
 * - PUT  /projects/:projectId/integrations/policies/:provider  - save one policy
 * - GET  /projects/:projectId/integrations/:provider/connect   - consent page (the link agents hand out)
 * - POST /projects/:projectId/integrations/:provider/connect   - allow: grant, then connect if needed
 *
 * User-scoped:
 * - GET    /me/integrations                 - personal connections and grants
 * - DELETE /me/integrations/grants/:grantId - revoke one project's access
 * - DELETE /me/integrations/:provider       - disconnect (revokes every grant for it)
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { getFrontendUrl } from '../lib/cloud-urls'
import { prisma } from '../lib/prisma'
import {
  deletePersonalConnection,
  getCredentialProvider,
  getPolicy,
  grantAccess,
  isValidProviderId,
  listPolicies,
  listUserIntegrations,
  PolicyValidationError,
  revokeGrant,
  savePolicy,
  type ActorFallback,
  type ActorMode,
} from '../services/integration-credentials'
import { ensureDefaultCredentialProviders } from '../services/integration-credentials/defaults'
import { signPersonalConnectState, verifyPersonalConnectState } from '../services/integration-credentials/connect-state'
import { getPersonalConnection } from '../services/integration-credentials/store'

type GitHubService = typeof import('../services/github.service')

export interface IntegrationCredentialRoutesConfig {
  loadGitHub?: () => Promise<GitHubService>
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function authUserId(c: Context): string | null {
  const auth = c.get('auth') as { userId?: string; via?: string } | undefined
  if (!auth?.userId || auth.via === 'runtimeToken') return null
  return auth.userId
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>` +
    `body{font-family:-apple-system,system-ui,sans-serif;max-width:440px;margin:64px auto;padding:0 20px;color:#111}` +
    `h1{font-size:20px}p{line-height:1.5;color:#444}button,a.btn{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;text-decoration:none;color:#111;display:inline-block}` +
    `button.primary{background:#111;color:#fff;border-color:#111}.row{display:flex;gap:8px;margin-top:20px}` +
    `</style></head><body>${body}</body></html>`
  )
}

export function integrationCredentialRoutes(config: IntegrationCredentialRoutesConfig = {}) {
  ensureDefaultCredentialProviders({ loadGitHub: config.loadGitHub })
  const router = new Hono()

  router.get('/projects/:projectId/integrations/policies', async (c) => {
    const projectId = c.req.param('projectId')
    const userId = authUserId(c)
    const policies = await listPolicies(projectId)
    const github = await getPolicy(projectId, 'github')
    const all = policies.some((p) => p.provider === 'github') ? policies : [github, ...policies]
    const me = userId ? await listUserIntegrations(userId) : { connections: [], grants: [] }
    return c.json({
      ok: true,
      policies: all.map((p) => ({
        ...p,
        label: getCredentialProvider(p.provider)?.label(p.provider) ?? p.provider,
        supportsPersonal: getCredentialProvider(p.provider)?.supportsPersonal ?? false,
        sharedIsMe: !!userId && p.sharedUserId === userId,
      })),
      me: {
        connections: me.connections,
        grants: me.grants.filter((g) => g.projectId === projectId),
      },
    })
  })

  router.put('/projects/:projectId/integrations/policies/:provider', async (c) => {
    const projectId = c.req.param('projectId')
    const provider = c.req.param('provider')
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in to change this setting' } }, 401)
    if (!isValidProviderId(provider)) {
      return c.json({ error: { code: 'invalid_request', message: `Unknown integration: ${provider}` } }, 400)
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    // A project's shared account can only be the caller's own: nobody can volunteer someone else's.
    let sharedUserId: string | null | undefined
    if (body.sharedIsMe === true) sharedUserId = userId
    else if (body.sharedIsMe === false) {
      const current = await getPolicy(projectId, provider)
      sharedUserId = current.sharedUserId === userId ? null : undefined
    }
    try {
      const policy = await savePolicy(
        projectId,
        provider,
        {
          ...(body.writeMode !== undefined ? { writeMode: body.writeMode as ActorMode } : {}),
          ...(body.readMode !== undefined ? { readMode: body.readMode as ActorMode } : {}),
          ...(body.fallback !== undefined ? { fallback: body.fallback as ActorFallback } : {}),
          ...(sharedUserId !== undefined ? { sharedUserId } : {}),
        },
        userId,
      )
      return c.json({ ok: true, policy: { ...policy, sharedIsMe: policy.sharedUserId === userId } })
    } catch (err: any) {
      if (err instanceof PolicyValidationError) {
        return c.json({ error: { code: 'invalid_request', message: err.message } }, 400)
      }
      throw err
    }
  })

  router.get('/projects/:projectId/integrations/:provider/connect', async (c) => {
    const projectId = c.req.param('projectId')
    const provider = c.req.param('provider')
    const userId = authUserId(c)
    if (!userId) return c.html(page('Sign in required', '<h1>Sign in to Shogo first</h1><p>Then open this link again.</p>'), 401)
    const adapter = isValidProviderId(provider) ? getCredentialProvider(provider) : null
    if (!adapter?.supportsPersonal) {
      return c.html(page('Not available', '<h1>Not available</h1><p>This integration only uses the project account.</p>'), 404)
    }
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })
    const label = adapter.label(provider)
    const connected = adapter.personal ? !!(await getPersonalConnection(userId, provider)) : true
    const state = signPersonalConnectState({ userId, provider, projectId })
    const action = `${c.req.path}`
    return c.html(
      page(
        `Allow ${project?.name ?? 'this agent'} to use ${label}`,
        `<h1>Let ${escapeHtml(project?.name ?? 'this agent')} act as you on ${escapeHtml(label)}?</h1>` +
          `<p>When you ask this agent to do something on ${escapeHtml(label)}, it will do it with your account, ` +
          `so issues, comments, and pull requests show you as the author. Other people's requests use their own accounts.</p>` +
          `<p>You can revoke this any time in Settings → Integrations.</p>` +
          `<form method="post" action="${escapeHtml(action)}">` +
          `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
          `<div class="row"><button class="primary" type="submit">${connected ? 'Allow' : `Allow and connect ${escapeHtml(label)}`}</button>` +
          `<a class="btn" href="${escapeHtml(getFrontendUrl())}">Cancel</a></div></form>`,
      ),
    )
  })

  router.post('/projects/:projectId/integrations/:provider/connect', async (c) => {
    const projectId = c.req.param('projectId')
    const provider = c.req.param('provider')
    const userId = authUserId(c)
    if (!userId) return c.html(page('Sign in required', '<h1>Sign in to Shogo first</h1>'), 401)
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
    const state = verifyPersonalConnectState(typeof form.state === 'string' ? form.state : null)
    // The form's own signed state is the CSRF check: it names this user, project, and provider.
    if (!state || state.userId !== userId || state.projectId !== projectId || state.provider !== provider) {
      return c.html(page('Link expired', '<h1>This link has expired</h1><p>Ask the agent for a new one.</p>'), 400)
    }
    const adapter = getCredentialProvider(provider)
    if (!adapter?.supportsPersonal) return c.html(page('Not available', '<h1>Not available</h1>'), 404)

    await grantAccess(userId, projectId, provider)
    const needsAccount = adapter.personal ? !(await getPersonalConnection(userId, provider)) : true
    if (needsAccount && adapter.beginConnect) {
      try {
        const { url } = await adapter.beginConnect({ userId, projectId, provider, returnUrl: getFrontendUrl() })
        return c.redirect(url)
      } catch (err: any) {
        return c.html(page('Could not connect', `<h1>Could not connect</h1><p>${escapeHtml(err?.message ?? String(err))}</p>`), 500)
      }
    }
    return c.html(connectedPage(adapter.label(provider), null))
  })

  router.get('/me/integrations', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    return c.json({ ok: true, ...(await listUserIntegrations(userId)) })
  })

  router.delete('/me/integrations/grants/:grantId', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const revoked = await revokeGrant(userId, c.req.param('grantId'))
    return revoked ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'No such grant' } }, 404)
  })

  router.delete('/me/integrations/:provider', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const provider = c.req.param('provider')
    if (!isValidProviderId(provider)) return c.json({ error: { code: 'invalid_request', message: 'Unknown integration' } }, 400)
    await deletePersonalConnection(userId, provider)
    return c.json({ ok: true })
  })

  return router
}

export function connectedPage(label: string, login: string | null): string {
  return page(
    `${label} connected`,
    `<h1>${escapeHtml(label)} connected${login ? ` as @${escapeHtml(login)}` : ''}</h1>` +
      `<p>You can close this tab and go back to the conversation. Ask the agent to try again and it will use your account.</p>`,
  )
}

export function connectFailedPage(message: string): string {
  return page('Could not connect', `<h1>Could not connect</h1><p>${escapeHtml(message)}</p>`)
}
