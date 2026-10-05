// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace actions API (`/api/v1/<method>`), Slack-style method names:
 *
 *   members.list         members:read (emails need members:read.email)
 *   channels.list        channels:read
 *   chat.postMessage     chat:write      { channel, text }
 *   chat.dm              chat:write      { user, text }
 *   channels.addMember   channels:manage { channel, users }
 *
 * Callers authenticate with `Authorization: Bearer shogo_sk_…`. Marketplace
 * app installs use their install token (`SHOGO_APP_TOKEN`): it is limited to
 * the install's live grant (re-read on every call, so revoking or uninstalling
 * cuts it off at once) and the app acts as its installed project's agent.
 * Personal keys act for their user with that user's workspace access.
 */

import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'
import { ConversationError } from '../services/conversation.service'
import { resolveApiKey } from './api-keys'

const db = prisma as any
const MAX_TEXT = 8_000

interface ActionAuth {
  workspaceId: string
  userId: string
  /** `'*'` for personal keys. */
  scopes: string[] | '*'
  app: { installId: string; projectId: string; name: string } | null
}

function fail(c: Context, status: 400 | 401 | 403 | 404 | 429, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ ok: false, error: code, message, ...extra }, status)
}

async function readParams(c: Context): Promise<Record<string, any>> {
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  if (c.req.method !== 'POST') return query
  const body = await c.req.json().catch(() => null)
  return { ...query, ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) }
}

async function authenticate(c: Context, params: Record<string, any>): Promise<ActionAuth | Response> {
  const header = c.req.header('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return fail(c, 401, 'not_authed', 'Send Authorization: Bearer <token>')
  const key = await resolveApiKey(token, { allowAppTokens: true })
  if (!key) return fail(c, 401, 'invalid_auth', 'The token is invalid, expired or revoked')

  let auth: ActionAuth
  if (key.kind === 'app') {
    const grant = key.installId ? await db.appInstallGrant.findUnique({ where: { installId: key.installId } }) : null
    const install = key.installId
      ? await db.marketplaceInstall.findUnique({ where: { id: key.installId }, include: { listing: { select: { title: true } } } })
      : null
    if (!grant || grant.status !== 'active' || !install || install.status !== 'active') {
      return fail(c, 401, 'token_revoked', "This app's access to the workspace was revoked")
    }
    auth = {
      workspaceId: key.workspaceId,
      userId: key.userId,
      scopes: grant.grantedScopes,
      app: { installId: install.id, projectId: install.projectId, name: install.listing.title },
    }
  } else {
    const member = await db.member.findFirst({ where: { workspaceId: key.workspaceId, userId: key.userId }, select: { id: true } })
    if (!member) return fail(c, 403, 'not_in_workspace', 'The key owner is no longer a member of this workspace')
    auth = { workspaceId: key.workspaceId, userId: key.userId, scopes: '*', app: null }
  }
  const requested = typeof params.workspaceId === 'string' && params.workspaceId ? params.workspaceId : c.req.header('x-shogo-workspace-id')
  if (requested && requested !== auth.workspaceId) {
    return fail(c, 403, 'wrong_workspace', 'This token belongs to a different workspace')
  }
  return auth
}

function hasScope(auth: ActionAuth, scope: string): boolean {
  return auth.scopes === '*' || auth.scopes.includes(scope)
}

type Handler = (c: Context, auth: ActionAuth, params: Record<string, any>) => Promise<Response>

function method(scope: string, handler: Handler) {
  return async (c: Context) => {
    const params = await readParams(c)
    const auth = await authenticate(c, params)
    if (auth instanceof Response) return auth
    if (!hasScope(auth, scope)) return fail(c, 403, 'missing_scope', `This token lacks the ${scope} scope`, { needed: scope })
    try {
      return await handler(c, auth, params)
    } catch (err: any) {
      if (err instanceof ConversationError) {
        return c.json({ ok: false, error: err.code, message: err.message }, err.status)
      }
      throw err
    }
  }
}

function text(params: Record<string, any>): string | null {
  const value = typeof params.text === 'string' ? params.text.trim() : ''
  return value ? value.slice(0, MAX_TEXT) : null
}

async function postAs(auth: ActionAuth, conversationId: string, body: string) {
  const { postAgentMessage } = await import('../services/chat-providers/outbound')
  const { afterMessagePosted } = await import('../services/conversation-pipeline')
  const { agentDisplayName } = await import('../services/conversation.service')
  const projectId = auth.app?.projectId ?? null
  const result = await postAgentMessage({
    conversationId,
    workspaceId: auth.workspaceId,
    text: body,
    agent: { projectId, name: auth.app?.name ?? await agentDisplayName(auth.workspaceId, projectId) },
  })
  void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
  return result
}

async function channelFor(auth: ActionAuth, channel: unknown) {
  if (typeof channel !== 'string' || !channel.trim()) return null
  const { resolveAgentConversation } = await import('./conversations')
  const conversation = await resolveAgentConversation(auth.workspaceId, channel.trim().replace(/^#/, ''), auth.app?.projectId ?? null)
  if (!conversation || conversation.archivedAt || !['public', 'private'].includes(conversation.kind)) return null
  return conversation
}

async function memberFor(workspaceId: string, who: unknown) {
  const value = typeof who === 'string' ? who.trim() : ''
  if (!value) return null
  return db.member.findFirst({
    where: { workspaceId, OR: [{ userId: value }, { user: { email: value } }, { user: { email: value.toLowerCase() } }] },
    select: { userId: true },
  })
}

export function appActionsRoutes(): Hono {
  const router = new Hono()

  const membersList = method('members:read', async (c, auth) => {
    const withEmail = hasScope(auth, 'members:read.email')
    const rows = await db.member.findMany({
      where: { workspaceId: auth.workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
    })
    return c.json({
      ok: true,
      members: rows.map((m: any) => ({
        userId: m.userId,
        name: m.user?.name ?? null,
        role: m.role,
        ...(withEmail ? { email: m.user?.email ?? null } : {}),
      })),
    })
  })
  router.get('/members.list', membersList)
  router.post('/members.list', membersList)

  const channelsList = method('channels:read', async (c, auth) => {
    const rows = await db.conversation.findMany({
      where: { workspaceId: auth.workspaceId, kind: 'public', archivedAt: null },
      select: { id: true, name: true, slug: true, topic: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
    return c.json({ ok: true, channels: rows })
  })
  router.get('/channels.list', channelsList)
  router.post('/channels.list', channelsList)

  router.post('/chat.postMessage', method('chat:write', async (c, auth, params) => {
    const body = text(params)
    if (!body) return fail(c, 400, 'invalid_arguments', 'text is required')
    const conversation = await channelFor(auth, params.channel)
    if (!conversation) return fail(c, 404, 'channel_not_found', 'No channel the app can post in matches that name or id')
    const result = await postAs(auth, conversation.id, body)
    return c.json({ ok: true, channel: conversation.id, message: { id: result.message.id } })
  }))

  router.post('/chat.dm', method('chat:write', async (c, auth, params) => {
    const body = text(params)
    if (!body) return fail(c, 400, 'invalid_arguments', 'text is required')
    const member = await memberFor(auth.workspaceId, params.user)
    if (!member) return fail(c, 404, 'user_not_found', 'No workspace member matches that user id or email')
    const { openAgentConversation } = await import('../services/conversation.service')
    const conversation = await openAgentConversation(auth.workspaceId, member.userId, { projectId: auth.app?.projectId ?? null })
    const result = await postAs(auth, conversation.id, body)
    return c.json({ ok: true, channel: conversation.id, message: { id: result.message.id } })
  }))

  router.post('/channels.addMember', method('channels:manage', async (c, auth, params) => {
    const users: string[] = Array.isArray(params.users) ? params.users.map(String) : typeof params.user === 'string' ? [params.user] : []
    if (!users.length) return fail(c, 400, 'invalid_arguments', 'users (ids or emails) is required')
    const conversation = await channelFor(auth, params.channel)
    if (!conversation) return fail(c, 404, 'channel_not_found', 'No channel the app can manage matches that name or id')
    const { addUserMembersAsAgent } = await import('../services/conversation.service')
    const added = await addUserMembersAsAgent(conversation, users.slice(0, 50))
    return c.json({ ok: true, channel: conversation.id, added })
  }))

  return router
}
