// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Acts as" settings for integrations, and personal connections.
 *
 * Project-scoped (behind requireProjectAccess):
 * - GET  /projects/:projectId/integrations/policies            - policies + what the caller has connected
 * - PUT  /projects/:projectId/integrations/policies/:provider  - save one policy
 * - POST /projects/:projectId/integrations/policies/:provider/delegate - unattended runs act as me
 * - DELETE same                                                 - stop (the delegate, or an admin)
 * - GET  /projects/:projectId/integrations/audit               - which account recent calls used (admins)
 * - GET  /projects/:projectId/integrations/:provider/connect   - consent page (the link agents hand out)
 * - POST /projects/:projectId/integrations/:provider/connect   - allow: grant, then connect if needed
 *
 * User-scoped:
 * - GET    /me/integrations                 - personal connections and grants
 * - GET    /me/integrations/:provider/access?projectId= - whether that agent can act as me
 * - DELETE /me/integrations/grants/:grantId - revoke one project's access
 * - DELETE /me/integrations/:provider       - disconnect (revokes every grant for it)
 *
 * The caller's own grant for a workspace (under /workspaces so writes route
 * to the workspace's home region):
 * - GET    /workspaces/:workspaceId/integrations/:provider/my-access - scope + every agent's access
 * - PUT    same                                                      - { scope }: own | all | selected
 * - DELETE same                                                      - stop every agent there
 * - PUT    /workspaces/:workspaceId/integrations/:provider/my-access/agents/:projectId
 *          - { allowed: true | false | null } (null: back to the workspace scope)
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { accessibleProjectsWhere, loadAccess } from '../lib/authz'
import { getFrontendUrl } from '../lib/cloud-urls'
import { prisma } from '../lib/prisma'
import {
  canActForProject,
  canEditCredentialPolicies,
  clearProjectGrant,
  deletePersonalConnection,
  getCredentialProvider,
  getPolicy,
  getWorkspaceGrant,
  grantAccess,
  hasActiveGrant,
  isValidProviderId,
  isWorkspaceGrantScope,
  isWorkspaceMember,
  listPolicies,
  listUserIntegrations,
  listWorkspaceAgentAccess,
  personalAccountFor,
  personalConnectUrl,
  PolicyValidationError,
  revokeGrant,
  revokeWorkspaceGrant,
  savePolicy,
  setDelegate,
  setWorkspaceGrant,
  WORKSPACE_GRANT_SCOPES,
  CHAIN_STEPS,
  type ActorFallback,
  type ActorMode,
  type ChainStep,
} from '../services/integration-credentials'
import { resumeAfterConnect, verifyResumeToken, type ResumeOutcome } from '../services/integration-credentials/resume'
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

/** What the consent page offers: a workspace scope, or just the agent the link came from. */
type ConsentScope = 'own' | 'all' | 'project'

/**
 * Record what someone allowed from an agent's consent link. A workspace
 * scope always covers the agent they consented from, even one they didn't
 * create.
 */
async function applyConsent(
  userId: string,
  projectId: string,
  provider: string,
  scope: string,
  usesGrants: boolean,
): Promise<void> {
  if (usesGrants && (scope === 'own' || scope === 'all')) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
    if (project && (await isWorkspaceMember(userId, project.workspaceId))) {
      await setWorkspaceGrant(userId, project.workspaceId, provider, scope)
      if (!(await hasActiveGrant(userId, projectId, provider))) await grantAccess(userId, projectId, provider)
      return
    }
  }
  await grantAccess(userId, projectId, provider)
}

/** A provider whose personal connections are gated by grants (not Composio, which keeps its own). */
function grantedProvider(provider: string) {
  const adapter = isValidProviderId(provider) ? getCredentialProvider(provider) : null
  return adapter?.supportsPersonal && adapter.personal ? adapter : null
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>` +
    `body{font-family:-apple-system,system-ui,sans-serif;max-width:440px;margin:64px auto;padding:0 20px;color:#111}` +
    `h1{font-size:20px}p{line-height:1.5;color:#444}button,a.btn{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;text-decoration:none;color:#111;display:inline-block}` +
    `button.primary{background:#111;color:#fff;border-color:#111}.row{display:flex;gap:8px;margin-top:20px}` +
    `fieldset{border:1px solid #e5e5e5;border-radius:10px;padding:8px 14px;margin:16px 0 0}legend{padding:0 4px;color:#444}` +
    `label{display:block;margin:8px 0}` +
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
    const delegateIds = [...new Set(all.map((p) => p.delegateUserId).filter((id): id is string => !!id))]
    const delegates = delegateIds.length
      ? await prisma.user.findMany({ where: { id: { in: delegateIds } }, select: { id: true, name: true, email: true } })
      : []
    const delegateName = (id: string | null) => {
      const user = id ? delegates.find((u: { id: string }) => u.id === id) : null
      return user ? user.name || user.email || 'Someone' : null
    }
    return c.json({
      ok: true,
      canEdit: !!userId && (await canEditCredentialPolicies(userId, projectId)),
      steps: CHAIN_STEPS,
      policies: all.map((p) => ({
        ...p,
        label: getCredentialProvider(p.provider)?.label(p.provider) ?? p.provider,
        supportsPersonal: getCredentialProvider(p.provider)?.supportsPersonal ?? false,
        supportsShared: getCredentialProvider(p.provider)?.supportsShared !== false,
        sharedIsMe: !!userId && p.sharedUserId === userId,
        delegateName: delegateName(p.delegateUserId),
        delegateIsMe: !!userId && p.delegateUserId === userId,
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
    if (!(await canEditCredentialPolicies(userId, projectId))) {
      return c.json(
        { error: { code: 'forbidden', message: 'Only the project owner and workspace admins can change what this agent acts as' } },
        403,
      )
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
          ...(body.writeChain !== undefined ? { writeChain: body.writeChain as ChainStep[] } : {}),
          ...(body.readChain !== undefined ? { readChain: body.readChain as ChainStep[] } : {}),
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

  // Unattended runs (no person, or a person who can't be acted as) act as the
  // delegate when the chain has a `delegate` step. Only you can make yourself
  // the delegate, and only with an account you've connected and allowed.
  router.post('/projects/:projectId/integrations/policies/:provider/delegate', async (c) => {
    const projectId = c.req.param('projectId')
    const provider = c.req.param('provider')
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in to change this setting' } }, 401)
    const adapter = isValidProviderId(provider) ? getCredentialProvider(provider) : null
    if (!adapter?.supportsPersonal) {
      return c.json({ error: { code: 'invalid_request', message: 'This integration only uses the project account' } }, 400)
    }
    if (!(await canActForProject(userId, projectId))) {
      return c.json({ error: { code: 'forbidden', message: 'Viewers cannot act for this agent' } }, 403)
    }
    const connected = adapter.personal ? !!(await getPersonalConnection(userId, provider)) : true
    if (connected) await grantAccess(userId, projectId, provider)
    const account = connected ? await personalAccountFor(projectId, provider, userId) : null
    if (!account) {
      return c.json(
        {
          error: {
            code: 'requester_auth_required',
            message: `Connect your ${adapter.label(provider)} account first`,
            connectUrl: personalConnectUrl(projectId, provider),
          },
        },
        409,
      )
    }
    const policy = await setDelegate(projectId, provider, userId)
    return c.json({
      ok: true,
      policy: { ...policy, delegateIsMe: true },
      actingAs: account.login ? `@${account.login}` : null,
    })
  })

  router.delete('/projects/:projectId/integrations/policies/:provider/delegate', async (c) => {
    const projectId = c.req.param('projectId')
    const provider = c.req.param('provider')
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in to change this setting' } }, 401)
    if (!isValidProviderId(provider)) {
      return c.json({ error: { code: 'invalid_request', message: `Unknown integration: ${provider}` } }, 400)
    }
    const current = await getPolicy(projectId, provider)
    if (current.delegateUserId !== userId && !(await canEditCredentialPolicies(userId, projectId))) {
      return c.json({ error: { code: 'forbidden', message: 'Only the delegate and admins can stop this' } }, 403)
    }
    const policy = current.delegateUserId ? await setDelegate(projectId, provider, null) : current
    return c.json({ ok: true, policy: { ...policy, delegateIsMe: false } })
  })

  router.get('/projects/:projectId/integrations/audit', async (c) => {
    const projectId = c.req.param('projectId')
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    if (!(await canEditCredentialPolicies(userId, projectId))) {
      return c.json({ error: { code: 'forbidden', message: 'Only the project owner and workspace admins can see this' } }, 403)
    }
    const provider = c.req.query('provider')
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
    const rows = await (prisma as any).integrationCredentialAudit.findMany({
      where: { projectId, ...(provider ? { provider } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    const people = [...new Set(rows.flatMap((r: any) => [r.actingUserId, r.requesterUserId]).filter(Boolean))] as string[]
    const users = people.length
      ? await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true, email: true } })
      : []
    const nameOf = (id: string | null) => {
      const user = id ? users.find((u: { id: string }) => u.id === id) : null
      return user ? user.name || user.email || null : null
    }
    return c.json({
      ok: true,
      entries: rows.map((r: any) => ({
        id: r.id,
        provider: r.provider,
        op: r.op,
        source: r.source,
        actingAs: r.actingAs,
        actingUserName: nameOf(r.actingUserId),
        requesterName: nameOf(r.requesterUserId),
        origin: typeof r.origin?.kind === 'string' ? r.origin.kind : null,
        approvalId: r.approvalId ?? null,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      })),
    })
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
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, workspaceId: true, workspace: { select: { name: true } } },
    })
    const label = adapter.label(provider)
    const connected = adapter.personal ? !!(await getPersonalConnection(userId, provider)) : true
    // Only carry the resume token for the person it was made for.
    const resume = c.req.query('resume')
    const resumeFor = verifyResumeToken(resume)?.userId === userId ? resume : undefined
    const state = signPersonalConnectState({ userId, provider, projectId, ...(resumeFor ? { resume: resumeFor } : {}) })
    const action = c.req.path
    const agentName = project?.name ?? 'this agent'
    const offerWorkspace = !!adapter.personal && !!project && (await isWorkspaceMember(userId, project.workspaceId))
    if (!offerWorkspace) {
      return c.html(
        page(
          `Allow ${agentName} to use ${label}`,
          `<h1>Let ${escapeHtml(agentName)} act as you on ${escapeHtml(label)}?</h1>` +
            `<p>When you ask this agent to do something on ${escapeHtml(label)}, it will do it with your account, ` +
            `so issues, comments, and pull requests show you as the author. Other people's requests use their own accounts.</p>` +
            `<p>You can revoke this any time in Settings → Integrations.</p>` +
            `<form method="post" action="${escapeHtml(action)}">` +
            `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
            `<input type="hidden" name="scope" value="project">` +
            `<div class="row"><button class="primary" type="submit">${connected ? 'Allow' : `Allow and connect ${escapeHtml(label)}`}</button>` +
            `<a class="btn" href="${escapeHtml(getFrontendUrl())}">Cancel</a></div></form>`,
        ),
      )
    }
    const workspaceName = project.workspace?.name ?? 'this workspace'
    const current = await getWorkspaceGrant(userId, project.workspaceId, provider)
    const selected: ConsentScope = current && current.scope !== 'selected' ? current.scope : 'own'
    const option = (value: ConsentScope, text: string) =>
      `<label><input type="radio" name="scope" value="${value}"${selected === value ? ' checked' : ''}> ${escapeHtml(text)}</label>`
    return c.html(
      page(
        `Let agents use your ${label} account`,
        `<h1>Let agents act as you on ${escapeHtml(label)}?</h1>` +
          `<p>When you ask an agent to do something on ${escapeHtml(label)}, it will do it with your account, ` +
          `so commits, issues, and pull requests show you as the author. Agents only use your account for your own requests; ` +
          `other people's requests use their own accounts.</p>` +
          `<form method="post" action="${escapeHtml(action)}">` +
          `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
          `<fieldset><legend>Which agents in ${escapeHtml(workspaceName)}?</legend>` +
          option('own', 'Agents I create') +
          option('all', `Every agent in ${workspaceName}`) +
          option('project', `Only ${agentName}`) +
          `</fieldset>` +
          `<p>You can change this, or pick agents one by one, any time in Settings → Integrations.</p>` +
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

    // Pages rendered before workspace grants existed post no scope: they meant this agent.
    const scope = typeof form.scope === 'string' ? form.scope : 'project'
    await applyConsent(userId, projectId, provider, scope, !!adapter.personal)
    const existing = adapter.personal ? await getPersonalConnection(userId, provider) : null
    const needsAccount = adapter.personal ? !existing : true
    if (needsAccount && adapter.beginConnect) {
      try {
        const { url } = await adapter.beginConnect({
          userId,
          projectId,
          provider,
          returnUrl: getFrontendUrl(),
          ...(state.resume ? { resume: state.resume } : {}),
        })
        return c.redirect(url)
      } catch (err: any) {
        return c.html(page('Could not connect', `<h1>Could not connect</h1><p>${escapeHtml(err?.message ?? String(err))}</p>`), 500)
      }
    }
    const label = adapter.label(provider)
    const login = existing?.externalLogin ?? null
    const resumed = await resumeAfterConnect({ userId, resume: state.resume, label, login }).catch((err) => {
      console.error('[IntegrationCredentials] Resume after consent failed:', err?.message ?? err)
      return { resumed: false } as const
    })
    return c.html(connectedPage(label, login, resumed))
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

  router.get('/me/integrations/:provider/access', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const provider = c.req.param('provider')
    const projectId = c.req.query('projectId')
    if (!isValidProviderId(provider) || !projectId) {
      return c.json({ error: { code: 'invalid_request', message: 'provider and projectId are required' } }, 400)
    }
    const adapter = getCredentialProvider(provider)
    if (!adapter?.supportsPersonal) return c.json({ ok: true, connected: false, allowed: false })
    if (!(await loadAccess({ userId, via: 'session' }, { projectId })).permissions.has('project:read')) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
    }
    const account = await personalAccountFor(projectId, provider, userId)
    const connected = adapter.personal ? !!(await getPersonalConnection(userId, provider)) : !!account
    return c.json({ ok: true, connected, allowed: !!account, login: account?.login ?? null })
  })

  router.get('/workspaces/:workspaceId/integrations/:provider/my-access', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const workspaceId = c.req.param('workspaceId')
    const provider = c.req.param('provider')
    const adapter = grantedProvider(provider)
    if (!adapter) return c.json({ error: { code: 'invalid_request', message: 'This integration has no per-agent access' } }, 400)
    if (!(await isWorkspaceMember(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }
    const [connection, grant, agents] = await Promise.all([
      getPersonalConnection(userId, provider),
      getWorkspaceGrant(userId, workspaceId, provider),
      accessibleProjectsWhere({ userId, via: 'session' }, workspaceId).then((visible) =>
        listWorkspaceAgentAccess(userId, workspaceId, provider, visible),
      ),
    ])
    return c.json({
      ok: true,
      label: adapter.label(provider),
      scopes: WORKSPACE_GRANT_SCOPES,
      connected: !!connection,
      login: connection?.externalLogin ?? null,
      scope: grant?.scope ?? null,
      agents,
    })
  })

  router.put('/workspaces/:workspaceId/integrations/:provider/my-access', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const workspaceId = c.req.param('workspaceId')
    const provider = c.req.param('provider')
    if (!grantedProvider(provider)) {
      return c.json({ error: { code: 'invalid_request', message: 'This integration has no per-agent access' } }, 400)
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (!isWorkspaceGrantScope(body.scope)) {
      return c.json({ error: { code: 'invalid_request', message: `scope must be one of ${WORKSPACE_GRANT_SCOPES.join(', ')}` } }, 400)
    }
    if (!(await isWorkspaceMember(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }
    await setWorkspaceGrant(userId, workspaceId, provider, body.scope)
    return c.json({ ok: true, scope: body.scope })
  })

  router.delete('/workspaces/:workspaceId/integrations/:provider/my-access', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const provider = c.req.param('provider')
    if (!isValidProviderId(provider)) return c.json({ error: { code: 'invalid_request', message: 'Unknown integration' } }, 400)
    await revokeWorkspaceGrant(userId, c.req.param('workspaceId'), provider)
    return c.json({ ok: true })
  })

  router.put('/workspaces/:workspaceId/integrations/:provider/my-access/agents/:projectId', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    const workspaceId = c.req.param('workspaceId')
    const provider = c.req.param('provider')
    const projectId = c.req.param('projectId')
    if (!grantedProvider(provider)) {
      return c.json({ error: { code: 'invalid_request', message: 'This integration has no per-agent access' } }, 400)
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (body.allowed !== true && body.allowed !== false && body.allowed !== null) {
      return c.json({ error: { code: 'invalid_request', message: 'allowed must be true, false, or null' } }, 400)
    }
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
    const canRead =
      project?.workspaceId === workspaceId &&
      (await loadAccess({ userId, via: 'session' }, { projectId })).permissions.has('project:read')
    if (!canRead) return c.json({ error: { code: 'not_found', message: 'No such agent in this workspace' } }, 404)
    if (body.allowed === null) await clearProjectGrant(userId, projectId, provider)
    else await grantAccess(userId, projectId, provider, body.allowed ? 'allow' : 'deny')
    return c.json({ ok: true, allowed: await hasActiveGrant(userId, projectId, provider) })
  })

  return router
}

export function connectedPage(label: string, login: string | null, resumed: ResumeOutcome = { resumed: false }): string {
  const next = resumed.resumed
    ? `<p>The agent is picking up where it left off${
        resumed.conversationName ? ` in ${escapeHtml(resumed.conversationName)}` : ''
      }, using your account. You can close this tab.</p>`
    : `<p>You can close this tab and go back to the conversation. Ask the agent to try again and it will use your account.</p>`
  return page(
    `${label} connected`,
    `<h1>${escapeHtml(label)} connected${login ? ` as @${escapeHtml(login)}` : ''}</h1>${next}`,
  )
}

export function connectFailedPage(message: string): string {
  return page('Could not connect', `<h1>Could not connect</h1><p>${escapeHtml(message)}</p>`)
}
