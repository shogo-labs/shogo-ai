// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace channels API: conversations, members, messages, threads,
 * reactions, files, read state, and the realtime socket/SSE endpoints.
 *
 * Mounted under `/api` for both the cloud and desktop composers.
 */

import { Hono } from 'hono'
import type { Permission } from '@shogo/authz'
import { prisma } from '../lib/prisma'
import { loadAccess as loadAuthzAccess } from '../lib/authz'
import { canReceive, subscribeWorkspaceEvents } from '../lib/conversation-bus'
import {
  MAX_CONVERSATION_FILE_BYTES,
  buildConversationFileKey,
  conversationFileUrl,
  putConversationFile,
  readConversationFile,
  verifyAttachmentToken,
} from '../lib/conversation-files'
import {
  ConversationError,
  addAgentMember,
  assertAgentInWorkspace,
  setAgentMuted,
  agentDisplayName,
  addUserMembers,
  createChannel,
  deleteMessage,
  editMessage,
  getConversationForUser,
  getMessage,
  getWorkspaceRole,
  joinConversation,
  leaveConversation,
  listConversationsForUser,
  listMentionables,
  listMessages,
  loadAccess,
  markRead,
  openAgentConversation,
  openDirectConversation,
  postMessage,
  removeMember,
  requirePost,
  serializeConversation,
  setAttachmentUrlBuilder,
  setReaction,
  updateConversation,
  updateMembership,
} from '../services/conversation.service'
import { afterMessagePosted } from '../services/conversation-pipeline'
import { AgentMessageError, postAgentMessage, updateAgentMessage } from '../services/chat-providers/outbound'
import { blocksForKind, cardToMarkdown, normalizeCard, normalizeKind } from '../services/conversation-message-kind'
import { listInstallations } from '../services/chat-providers/installations'
import { CHAT_RATE_LIMITS, takeRateLimit } from '../lib/chat-limits'
import { getFrontendUrl } from '../lib/cloud-urls'
import { adoptSlackRouting } from '../services/chat-providers/slack-adopt'
import { catchUp } from '../services/conversation-activity'
import { respondToPermission, stopAgentReply } from '../services/conversation-agent-dispatcher'
import { decideApproval, listPendingApprovals } from '../services/conversation-approvals'
import { liveActivityApprovalAnswered } from '../services/approval-live-activity'
import { loadWorkLog } from '../services/agent-work-log'
import { chainForAgentPost, rootChain, setThreadOwner } from '../services/conversation-agent-chain'
import { loadAgentCard, loadTeamDirectory, resolveFriendlyMentions, setAgentBuddyLook } from '../services/conversation-directory'
import { listTeamChannels, TeamChannelError, upsertTeamChannel } from '../services/conversation-team-channels'
import { getPresence } from '../services/conversation-presence'
import { getChannelMetrics } from '../services/conversation-metrics'
import { searchMessages } from '../services/conversation-search'
import { askWorkspace, semanticSearch } from '../services/conversation-semantic'
import { canExtract, extractAndStoreAttachmentText } from '../services/conversation-file-text'
import { registerConversationNotifications } from '../services/conversation-notifications'
import { registerConversationUnfurls } from '../services/conversation-unfurl'
import { listStatuses } from '../services/chat-settings'
import { listGroups } from '../services/chat-customization'
import { mountConversationExtras } from './conversation-extras'
import { mountHuddleRoutes } from './huddles'
import { agentChatEnabled, assertNativeChat, getWorkspaceChatConfig, setWorkspaceChatConfig } from '../services/chat-mode'
import type { ConversationSocketData } from '../realtime/conversation-socket'

const db = prisma as any

setAttachmentUrlBuilder(conversationFileUrl)

export interface ConversationRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof ConversationError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status)
  }
  throw err
}

type ChatLimit = (typeof CHAT_RATE_LIMITS)[keyof typeof CHAT_RATE_LIMITS]

/** A 429 response once `key` is over its limit, else null. */
async function rateLimited(c: any, key: string, limit: ChatLimit): Promise<Response | null> {
  const result = await takeRateLimit(key, limit.max, limit.windowMs)
  if (result.allowed) return null
  c.header('Retry-After', String(result.retryAfterSeconds))
  return c.json({ error: { code: 'rate_limited', message: 'Slow down a little and try again in a moment.' } }, 429)
}

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

async function userCan(userId: string, permission: Permission, workspaceId: string): Promise<boolean> {
  return (await loadAuthzAccess({ userId, via: 'session' }, { workspaceId })).permissions.has(permission)
}

function numberParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function conversationRoutes(config: ConversationRoutesConfig): Hono {
  const router = new Hono()
  registerConversationNotifications()
  registerConversationUnfurls()

  async function requireUser(c: any): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    return userId
  }

  async function requireWorkspace(c: any): Promise<{ userId: string; workspaceId: string } | Response> {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const workspaceId = c.req.param('workspaceId')
    if (!(await getWorkspaceRole(workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    }
    try {
      await assertNativeChat(workspaceId)
    } catch (err) {
      return errorResponse(c, err)
    }
    return { userId, workspaceId }
  }

  // Reachable in every mode so clients can learn whether to show team chat.
  router.get('/workspaces/:workspaceId/chat-mode', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const workspaceId = c.req.param('workspaceId')
    const role = await getWorkspaceRole(workspaceId, userId)
    if (!role) return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    const [config, installations, canManage] = await Promise.all([
      getWorkspaceChatConfig(workspaceId),
      listInstallations(workspaceId),
      userCan(userId, 'workspace.settings:manage', workspaceId),
    ])
    return c.json({
      ...config,
      canManage,
      installations: installations.map((i: any) => ({ provider: i.provider, tenantName: i.tenantName, createdAt: i.createdAt })),
    })
  })

  router.patch('/workspaces/:workspaceId/chat-mode', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const workspaceId = c.req.param('workspaceId')
    if (!(await userCan(userId, 'workspace.settings:manage', workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Only workspace admins can change team chat settings' } }, 403)
    }
    const body = await readJson(c)
    try {
      const config = await setWorkspaceChatConfig(workspaceId, { mode: body.mode, provider: body.provider })
      if (config.provider === 'slack') await adoptSlackRouting(workspaceId)
      const installations = await listInstallations(workspaceId)
      return c.json({
        ...config,
        canManage: true,
        installations: installations.map((i: any) => ({ provider: i.provider, tenantName: i.tenantName, createdAt: i.createdAt })),
      })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  mountConversationExtras(router, { requireUser, requireWorkspace, errorResponse, readJson })
  mountHuddleRoutes(router, { requireUser, requireWorkspace, errorResponse })

  // ─── Workspace-level ─────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/conversations', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ conversations: await listConversationsForUser(auth.workspaceId, auth.userId) })
  })

  /** Approvals agents are waiting on that this person can answer (viewers see none). */
  router.get('/workspaces/:workspaceId/approvals/pending', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    if ((await getWorkspaceRole(auth.workspaceId, auth.userId)) === 'viewer') return c.json({ approvals: [] })
    try {
      return c.json({ approvals: await listPendingApprovals(auth.workspaceId, auth.userId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/conversations', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      const conversation = await createChannel({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        name: String(body.name ?? ''),
        kind: body.kind === 'private' ? 'private' : 'public',
        topic: typeof body.topic === 'string' ? body.topic : null,
        memberUserIds: Array.isArray(body.memberUserIds) ? body.memberUserIds : [],
      })
      return c.json({ conversation: serializeConversation(conversation, { joined: true }) }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/dms', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const limited = await rateLimited(c, `dm:${auth.userId}`, CHAT_RATE_LIMITS.dmOpen)
    if (limited) return limited
    const body = await readJson(c)
    try {
      const agent = body.agent && typeof body.agent === 'object'
        ? { projectId: typeof body.agent.projectId === 'string' ? body.agent.projectId : null }
        : null
      if (agent) await assertAgentInWorkspace(auth.workspaceId, agent, auth.userId)
      const conversation = agent
        ? await openAgentConversation(auth.workspaceId, auth.userId, agent)
        : await openDirectConversation(auth.workspaceId, auth.userId, Array.isArray(body.userIds) ? body.userIds : [])
      return c.json({ conversation: await getConversationForUser(conversation.id, auth.userId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/mentionables', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const [mentionables, statuses, groups] = await Promise.all([
      listMentionables(auth.workspaceId, auth.userId),
      listStatuses(auth.workspaceId),
      listGroups(auth.workspaceId),
    ])
    return c.json({ ...mentionables, statuses, groups })
  })

  /** Profile card for an agent; `projectId` is empty for the workspace agent. */
  router.get('/workspaces/:workspaceId/agent-card', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const projectId = c.req.query('projectId')?.trim() || null
    const card = await loadAgentCard(auth.workspaceId, projectId, auth.userId)
    if (!card) return c.json({ error: { code: 'not_found', message: 'Agent not found' } }, 404)
    return c.json({ card })
  })

  /**
   * Change an agent's Shogo buddy look. `:key` is `ws` (the workspace agent) or a project id;
   * `{ look: null }` goes back to the look generated from the agent's id.
   */
  router.put('/workspaces/:workspaceId/agents/:key/buddy', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    if (!('look' in body)) return c.json({ error: { code: 'invalid_look', message: 'look is required (an object, or null to reset)' } }, 400)
    try {
      return c.json(await setAgentBuddyLook(auth.workspaceId, auth.userId, c.req.param('key'), body.look))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/presence', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const ids = (c.req.query('userIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500)
    return c.json({ presence: await getPresence(auth.workspaceId, ids) })
  })

  router.get('/workspaces/:workspaceId/conversations/search', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const q = c.req.query('q') ?? ''
    if (c.req.query('mode') === 'semantic') {
      const { results, available } = await semanticSearch(auth.workspaceId, auth.userId, q, { limit: numberParam(c.req.query('limit')) })
      return c.json({ results, terms: [], hasMore: false, semantic: available })
    }
    return c.json(await searchMessages(auth.workspaceId, auth.userId, q, {
      limit: numberParam(c.req.query('limit')),
      offset: numberParam(c.req.query('offset')),
      sort: c.req.query('sort') === 'recent' ? 'recent' : 'relevance',
      timezone: c.req.query('tz') ?? null,
    }))
  })

  router.post('/workspaces/:workspaceId/conversations/ask', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(await askWorkspace(auth.workspaceId, auth.userId, String(body.question ?? '')))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/conversations/metrics', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    if (!(await userCan(auth.userId, 'workspace.analytics:read', auth.workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Only workspace admins can view channel metrics' } }, 403)
    }
    return c.json(await getChannelMetrics(auth.workspaceId, { weeks: numberParam(c.req.query('weeks')) }))
  })

  /** Realtime WebSocket. Auth runs through the normal middleware before the upgrade. */
  router.get('/workspaces/:workspaceId/rt', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const server = c.env as any
    if (!server?.upgrade || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: { code: 'upgrade_required', message: 'WebSocket upgrade required' } }, 426)
    }
    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { name: true, email: true } })
    const data: ConversationSocketData = {
      kind: 'conversation-rt',
      userId: auth.userId,
      userName: user?.name || user?.email || 'Someone',
      workspaceId: auth.workspaceId,
      server: typeof server.publish === 'function' ? server : undefined,
    }
    if (server.upgrade(c.req.raw, { data })) return new Response(null)
    return c.json({ error: { code: 'upgrade_failed', message: 'WebSocket upgrade failed' } }, 500)
  })

  /** Read-only realtime fallback for clients that cannot hold a WebSocket. */
  router.get('/workspaces/:workspaceId/conversations/events', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            cleanup()
          }
        }
        send(`data: ${JSON.stringify({ type: 'ready', workspaceId: auth.workspaceId, userId: auth.userId })}\n\n`)
        const unsubscribe = subscribeWorkspaceEvents(auth.workspaceId, (envelope) => {
          if (!canReceive(envelope, auth.userId)) return
          send(`data: ${JSON.stringify(envelope.event)}\n\n`)
        })
        const keepalive = setInterval(() => send(': keepalive\n\n'), 25_000)
        cleanup = () => {
          clearInterval(keepalive)
          unsubscribe()
        }
        c.req.raw.signal?.addEventListener('abort', () => {
          cleanup()
          try { controller.close() } catch {}
        })
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  // ─── Conversation-level ──────────────────────────────────────────────────

  router.get('/conversations/:conversationId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ conversation: await getConversationForUser(c.req.param('conversationId'), userId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/conversations/:conversationId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const updated = await updateConversation(c.req.param('conversationId'), userId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        topic: body.topic === null || typeof body.topic === 'string' ? body.topic : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
        kind: body.kind === 'public' || body.kind === 'private' ? body.kind : undefined,
      })
      return c.json({ conversation: serializeConversation(updated) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/join', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      await joinConversation(c.req.param('conversationId'), userId)
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/leave', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      await leaveConversation(c.req.param('conversationId'), userId)
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/members', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const added = await addUserMembers(c.req.param('conversationId'), userId, Array.isArray(body.userIds) ? body.userIds : [])
      return c.json({ added })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/conversations/:conversationId/members/:memberId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      await removeMember(c.req.param('conversationId'), userId, c.req.param('memberId'))
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/agents', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const member = await addAgentMember(c.req.param('conversationId'), userId, {
        projectId: typeof body.projectId === 'string' ? body.projectId : null,
        trigger: typeof body.trigger === 'string' ? body.trigger : undefined,
        keywords: typeof body.keywords === 'string' ? body.keywords : null,
      })
      return c.json({ member })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/conversations/:conversationId/agents', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    if (typeof body.muted !== 'boolean') return c.json({ error: { code: 'invalid_request', message: 'muted must be true or false' } }, 400)
    try {
      await setAgentMuted(c.req.param('conversationId'), userId, { projectId: typeof body.projectId === 'string' ? body.projectId : null }, body.muted)
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/conversations/:conversationId/membership', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      await updateMembership(c.req.param('conversationId'), userId, body)
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/conversations/:conversationId/messages', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await listMessages(c.req.param('conversationId'), userId, {
        beforeSeq: numberParam(c.req.query('beforeSeq')),
        afterSeq: numberParam(c.req.query('afterSeq')),
        limit: numberParam(c.req.query('limit')),
        threadRootId: c.req.query('threadRootId') || undefined,
      }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/messages', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const limited = await rateLimited(c, `msg:${userId}`, CHAT_RATE_LIMITS.message)
    if (limited) return limited
    const body = await readJson(c)
    try {
      const threadRootId = typeof body.threadRootId === 'string' ? body.threadRootId : null
      const access = await requirePost(c.req.param('conversationId'), userId, { threadReply: !!threadRootId })
      if (!access.membership && (access.conversation.kind === 'public' || access.conversation.kind === 'activity')) {
        await joinConversation(access.conversation.id, userId)
      }
      const result = await postMessage({
        conversationId: access.conversation.id,
        text: typeof body.text === 'string' ? body.text : '',
        authorType: 'user',
        authorUserId: userId,
        threadRootId,
        alsoSentToChannel: body.alsoSentToChannel === true && access.conversation.kind !== 'activity',
        clientMsgId: typeof body.clientMsgId === 'string' ? body.clientMsgId.slice(0, 100) : null,
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
      })
      void afterMessagePosted(result, { actorUserId: userId, origin: 'app' })
      return c.json({ message: result.message }, result.duplicate ? 200 : 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/read', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      return c.json(await markRead(c.req.param('conversationId'), userId, typeof body.seq === 'number' ? body.seq : undefined))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/catch-up', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await catchUp(c.req.param('conversationId'), userId))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/attachments', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      const access = await requirePost(c.req.param('conversationId'), userId, { threadReply: true })
      const form = await c.req.formData().catch(() => null)
      const file = form?.get('file')
      if (!file || typeof file === 'string') {
        return c.json({ error: { code: 'invalid_file', message: 'Attach a file in the "file" field' } }, 400)
      }
      if (file.size > MAX_CONVERSATION_FILE_BYTES) {
        return c.json({ error: { code: 'too_large', message: 'Files are limited to 50 MB' } }, 413)
      }
      const name = (file as File).name || 'file'
      const mimeType = file.type || 'application/octet-stream'
      const key = buildConversationFileKey(access.conversation.workspaceId, access.conversation.id, name)
      const bytes = new Uint8Array(await file.arrayBuffer())
      await putConversationFile(key, bytes, mimeType)
      const width = numberParam(String(form?.get('width') ?? ''))
      const height = numberParam(String(form?.get('height') ?? ''))
      const row = await db.conversationAttachment.create({
        data: {
          conversationId: access.conversation.id,
          uploaderUserId: userId,
          storageKey: key,
          name: name.slice(0, 255),
          mimeType,
          size: file.size,
          width: width ?? null,
          height: height ?? null,
        },
      })
      if (canExtract(mimeType, name, file.size)) {
        void extractAndStoreAttachmentText(row.id, bytes, mimeType, name).catch(() => {})
      }
      return c.json({
        attachment: {
          id: row.id, name: row.name, mimeType: row.mimeType, size: row.size,
          width: row.width, height: row.height, url: conversationFileUrl(row),
        },
      }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // ─── Message-level ───────────────────────────────────────────────────────

  router.get('/conversation-messages/:messageId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ message: await getMessage(c.req.param('messageId'), userId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/conversation-messages/:messageId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      return c.json({ message: await editMessage(c.req.param('messageId'), userId, String(body.text ?? '')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/conversation-messages/:messageId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ message: await deleteMessage(c.req.param('messageId'), userId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/reactions', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const limited = await rateLimited(c, `react:${userId}`, CHAT_RATE_LIMITS.reaction)
    if (limited) return limited
    const body = await readJson(c)
    try {
      const reactions = await setReaction(c.req.param('messageId'), userId, String(body.emoji ?? ''), body.on !== false)
      return c.json({ reactions })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/stop', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const row = await db.conversationMessage.findUnique({ where: { id: c.req.param('messageId') } })
    if (!row || row.authorType !== 'agent') {
      return c.json({ error: { code: 'not_found', message: 'Agent reply not found' } }, 404)
    }
    try {
      const access = await loadAccess(row.conversationId, userId)
      if (access.role === 'viewer') return c.json({ error: { code: 'forbidden', message: 'Viewers cannot stop agents' } }, 403)
      if (row.agentStatus === 'running') await stopAgentReply(row, userId)
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /** Approve or deny an action an agent is waiting on; the first answer wins. */
  router.post('/conversation-messages/:messageId/approval', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    const decision = body.decision === 'approve' || body.decision === 'deny' ? body.decision : null
    if (!decision) return c.json({ error: { code: 'invalid_decision', message: 'decision must be approve or deny' } }, 400)
    const row = await db.conversationMessage.findUnique({ where: { id: c.req.param('messageId') } })
    if (!row || row.authorType !== 'agent') {
      return c.json({ error: { code: 'not_found', message: 'Approval request not found' } }, 404)
    }
    try {
      const access = await loadAccess(row.conversationId, userId)
      if (access.role === 'viewer') return c.json({ error: { code: 'forbidden', message: 'Viewers cannot approve agent actions' } }, 403)
      const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }).catch(() => null)
      const result = await decideApproval({
        messageId: row.id,
        decision,
        by: { userId, name: user?.name || user?.email || 'Someone' },
        respond: respondToPermission,
      })
      void liveActivityApprovalAnswered(userId, {
        projectId: result.approval.projectId,
        agentName: row.authorAgentRef?.name?.trim() || 'Agent',
        decision,
      })
      return c.json({ message: result.message, approval: result.approval })
    } catch (err) {
      if (err instanceof AgentMessageError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
      return errorResponse(c, err)
    }
  })

  /** What an agent did before its final message, trimmed for the channel (see agent-work-log). */
  router.get('/conversation-messages/:messageId/work', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const row = await db.conversationMessage.findUnique({ where: { id: c.req.param('messageId') } })
    if (!row || row.authorType !== 'agent' || row.deletedAt) {
      return c.json({ error: { code: 'not_found', message: 'Message not found' } }, 404)
    }
    try {
      await loadAccess(row.conversationId, userId)
      const log = await loadWorkLog(row)
      if (!log) return c.json({ error: { code: 'not_found', message: 'No work log for this message' } }, 404)
      return c.json(log)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // ─── Files (capability URL) ──────────────────────────────────────────────

  router.get('/conversation-files/:attachmentId', async (c) => {
    const id = c.req.param('attachmentId')
    const row = await db.conversationAttachment.findUnique({ where: { id } })
    if (!row) return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
    const conversation = await db.conversation.findUnique({ where: { id: row.conversationId }, select: { workspaceId: true } })
    if (!conversation || (await getWorkspaceChatConfig(conversation.workspaceId)).mode === 'off') {
      return c.json({ error: { code: 'chat_disabled', message: 'Team chat is turned off for this workspace' } }, 403)
    }
    let allowed = verifyAttachmentToken(id, c.req.query('t'))
    if (!allowed) {
      const userId = await config.resolveUserId(c)
      if (userId) allowed = await loadAccess(row.conversationId, userId).then(() => true, () => false)
    }
    if (!allowed) return c.json({ error: { code: 'forbidden', message: 'No access to this file' } }, 403)
    try {
      const file = await readConversationFile(row.storageKey)
      if (file.kind === 'redirect') return c.redirect(file.url, 302)
      const inline = /^(image|video|audio)\//.test(row.mimeType) || row.mimeType === 'application/pdf'
      return new Response(file.bytes as any, {
        headers: {
          'Content-Type': row.mimeType,
          'Content-Length': String(file.bytes.byteLength),
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          'Cache-Control': 'private, max-age=300',
        },
      })
    } catch {
      return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
    }
  })

  return router
}

// ─── Runtime-facing routes (agent channel tools) ───────────────────────────

export interface AgentChannelAuthContext {
  workspaceId: string
  /** Agent identity from the runtime token: a project id, null for the workspace agent, undefined when unknown (SA). */
  projectId: string | null | undefined
}

export interface AgentChannelRoutesConfig {
  authorize: (c: any) => Promise<AgentChannelAuthContext | Response>
}

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export function textContains(q: string) {
  return isLocalMode() ? { contains: q } : { contains: q, mode: 'insensitive' as const }
}

export async function resolveAgentConversation(workspaceId: string, channel: string, projectId: string | null) {
  const byId = await db.conversation.findUnique({ where: { id: channel } }).catch(() => null)
  const conversation = byId && byId.workspaceId === workspaceId
    ? byId
    : await db.conversation.findFirst({ where: { workspaceId, slug: channel.toLowerCase() } })
  if (!conversation) return null
  if (conversation.kind === 'public' || conversation.kind === 'activity') return conversation
  const member = await db.conversationMember.findFirst({
    where: { conversationId: conversation.id, memberType: 'agent', projectId },
    select: { id: true },
  })
  return member ? conversation : null
}

async function renderForAgent(rows: any[]) {
  const { collectMentionIds, renderMentionsAsText } = await import('../services/conversation-mentions')
  const ids = collectMentionIds(rows.map((r) => r.text))
  const [users, projects] = await Promise.all([
    ids.userIds.length ? db.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, name: true, email: true } }) : [],
    ids.projectIds.length ? db.project.findMany({ where: { id: { in: ids.projectIds } }, select: { id: true, name: true } }) : [],
  ])
  const names = {
    users: new Map<string, string>(users.map((u: any) => [u.id, `${u.name || u.email} (<@u:${u.id}>)`])),
    projects: new Map<string, string>(projects.map((p: any) => [p.id, `${p.name} (<@a:p:${p.id}>)`])),
  }
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    author: r.authorType === 'user'
      ? `${r.authorUser?.name || r.authorUser?.email || 'Someone'} (<@u:${r.authorUserId}>)`
      : r.authorType === 'agent' ? `${r.authorAgentRef?.name ?? 'Agent'} (agent)` : r.authorType,
    authorType: r.authorType,
    text: renderMentionsAsText(r.text, names),
    threadRootId: r.threadRootId ?? null,
    replyCount: r.replyCount ?? 0,
    createdAt: r.createdAt,
  }))
}

export function agentChannelRoutes(routeConfig: AgentChannelRoutesConfig): Hono {
  const router = new Hono()
  const base = '/workspaces/:workspaceId/agent-channels'
  const config: AgentChannelRoutesConfig = {
    authorize: async (c) => {
      const auth = await routeConfig.authorize(c)
      if (auth instanceof Response) return auth
      if (!agentChatEnabled(await getWorkspaceChatConfig(auth.workspaceId))) {
        return c.json({ error: { code: 'chat_disabled', message: 'Team chat is turned off for this workspace' } }, 403)
      }
      return auth
    },
  }

  async function agentIdentity(auth: AgentChannelAuthContext, claimed: unknown): Promise<string | null> {
    if (auth.projectId !== undefined) return auth.projectId
    if (typeof claimed !== 'string' || !claimed) return null
    const project = await db.project.findUnique({ where: { id: claimed }, select: { workspaceId: true } })
    return project?.workspaceId === auth.workspaceId ? claimed : null
  }

  router.get(base, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const rows = await db.conversation.findMany({
      where: { workspaceId: auth.workspaceId, kind: { in: ['public', 'activity'] }, archivedAt: null },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true, kind: true, name: true, topic: true, lastMessageAt: true },
    })
    return c.json({ channels: rows })
  })

  router.get(`${base}/directory`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ directory: await loadTeamDirectory(auth.workspaceId, auth.projectId ?? null) })
  })

  router.get(`${base}/team-channels`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    return c.json(await listTeamChannels(auth.workspaceId))
  })

  router.put(`${base}/team-channels/:name`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      const result = await upsertTeamChannel(auth.workspaceId, { ...body, name: c.req.param('name') })
      return c.json(result, result.created ? 201 : 200)
    } catch (err) {
      if (err instanceof TeamChannelError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
      return errorResponse(c, err)
    }
  })

  /** Chain for an agent's tool post: joins the reply it's running in, and inherits the thread's run id. */
  async function postChain(workspaceId: string, projectId: string | null, body: any, threadRootId: string | null) {
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim().slice(0, 200) : null
    const chain = await chainForAgentPost({
      workspaceId,
      agent: { projectId },
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      runId,
    })
    if (chain && !chain.runId && threadRootId) {
      const inherited = (await rootChain(threadRootId))?.runId
      if (inherited) chain.runId = inherited
    }
    return chain
  }

  const ISOLATED_ERROR = {
    error: { code: 'isolated', message: 'You review without the discussion: work from the hand-off, the acceptance criteria and the links you were given.' },
  }

  /** Isolated agents (reviewers) must not read the discussion they were kept out of. */
  async function isolatedIn(conversationId: string, projectId: string | null): Promise<boolean> {
    const member = await db.conversationMember.findFirst({
      where: { conversationId, memberType: 'agent', projectId },
      select: { agentContextMode: true },
    })
    return member?.agentContextMode === 'isolated'
  }

  async function isolatedAnywhere(projectId: string | null): Promise<boolean> {
    if (!projectId) return false
    return !!(await db.conversationMember.findFirst({
      where: { memberType: 'agent', projectId, agentContextMode: 'isolated' },
      select: { id: true },
    }))
  }

  router.get(`${base}/search`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const searcher = await agentIdentity(auth, c.req.query('projectId'))
    if (await isolatedAnywhere(searcher)) return c.json(ISOLATED_ERROR, 403)
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json({ results: [] })
    const limit = Math.min(Number(c.req.query('limit')) || 20, 50)
    const rows = await db.conversationMessage.findMany({
      where: {
        workspaceId: auth.workspaceId,
        deletedAt: null,
        text: textContains(q),
        conversation: { kind: { in: ['public', 'activity'] } },
      },
      include: { authorUser: { select: { name: true, email: true } }, conversation: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    const rendered = await renderForAgent(rows)
    return c.json({ results: rendered.map((r, i) => ({ ...r, channel: rows[i].conversation?.name ?? null })) })
  })

  router.get(`${base}/:channel/messages`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const projectId = await agentIdentity(auth, c.req.query('projectId'))
    const conversation = await resolveAgentConversation(auth.workspaceId, c.req.param('channel'), projectId)
    if (!conversation) return c.json({ error: { code: 'not_found', message: 'Channel not found or not visible to this agent' } }, 404)
    if (await isolatedIn(conversation.id, projectId)) return c.json(ISOLATED_ERROR, 403)
    const limit = Math.min(Number(c.req.query('limit')) || 30, 100)
    const threadRootId = c.req.query('threadRootId')
    const rows = threadRootId
      ? await db.conversationMessage.findMany({
          where: { conversationId: conversation.id, OR: [{ id: threadRootId }, { threadRootId }], deletedAt: null },
          include: { authorUser: { select: { name: true, email: true } } },
          orderBy: { seq: 'asc' },
          take: limit,
        })
      : (await db.conversationMessage.findMany({
          where: { conversationId: conversation.id, threadRootId: null, deletedAt: null },
          include: { authorUser: { select: { name: true, email: true } } },
          orderBy: { seq: 'desc' },
          take: limit,
        })).reverse()
    return c.json({
      channel: { id: conversation.id, kind: conversation.kind, name: conversation.name, topic: conversation.topic, lastMessageAt: conversation.lastMessageAt },
      messages: await renderForAgent(rows),
    })
  })

  router.post(`${base}/:channel/messages`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    const projectId = await agentIdentity(auth, body.projectId)
    const limited = await rateLimited(c, `agent:${auth.workspaceId}:${projectId ?? 'ws'}`, CHAT_RATE_LIMITS.agentPost)
    if (limited) return limited
    const conversation = await resolveAgentConversation(auth.workspaceId, c.req.param('channel'), projectId)
    if (!conversation || conversation.kind === 'activity' || conversation.archivedAt) {
      return c.json({ error: { code: 'not_found', message: 'Channel not found or not open to agent posts' } }, 404)
    }
    try {
      const threadRootId = typeof body.threadRootId === 'string' ? body.threadRootId : null
      const agentChain = await postChain(auth.workspaceId, projectId, body, threadRootId)
      const card = body.card === undefined || body.card === null ? null : normalizeCard(body.card)
      if (body.card !== undefined && body.card !== null && !card) {
        return c.json({ error: { code: 'invalid_card', message: 'A status card needs a title' } }, 400)
      }
      // A card is routine by default; agents mark it a decision or alert when it needs a person.
      const kind = normalizeKind(body.kind) ?? (card ? 'status' : null)
      const note = String(body.text ?? '')
      const result = await postAgentMessage({
        conversationId: conversation.id,
        text: await resolveFriendlyMentions(auth.workspaceId, card ? [cardToMarkdown(card), note.trim()].filter(Boolean).join('\n\n') : note, projectId),
        agent: { projectId, name: await agentDisplayName(auth.workspaceId, projectId) },
        threadRootId,
        agentChain,
        blocks: blocksForKind({ kind, card }),
      })
      const rootId = result.row.threadRootId ?? result.row.id
      if (!result.duplicate && (body.owner === true || (!result.row.threadRootId && body.owner !== false))) {
        await setThreadOwner(rootId, { projectId }, agentChain?.runId)
      }
      void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
      return c.json({
        message: {
          id: result.message.id,
          conversationId: conversation.id,
          threadRootId: rootId,
          runId: agentChain?.runId ?? null,
          url: `${getFrontendUrl()}/c/${encodeURIComponent(conversation.id)}?thread=${encodeURIComponent(rootId)}`,
        },
      }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /** An agent edits one of its own messages in place: its text, kind, or status card. */
  router.patch(`${base}/messages/:messageId`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    const projectId = await agentIdentity(auth, body.projectId)
    const limited = await rateLimited(c, `agent:${auth.workspaceId}:${projectId ?? 'ws'}`, CHAT_RATE_LIMITS.agentPost)
    if (limited) return limited
    const card = body.card === undefined || body.card === null ? null : normalizeCard(body.card)
    if (body.card !== undefined && body.card !== null && !card) {
      return c.json({ error: { code: 'invalid_card', message: 'A status card needs a title' } }, 400)
    }
    try {
      const { message } = await updateAgentMessage({
        messageId: c.req.param('messageId'),
        workspaceId: auth.workspaceId,
        projectId,
        text: typeof body.text === 'string' ? await resolveFriendlyMentions(auth.workspaceId, body.text, projectId) : undefined,
        kind: normalizeKind(body.kind),
        card,
      })
      return c.json({ message: { id: message.id, conversationId: message.conversationId } })
    } catch (err) {
      if (err instanceof AgentMessageError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/:channel/members`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    const projectId = await agentIdentity(auth, body.projectId)
    const users = Array.isArray(body.users) ? body.users.map(String) : typeof body.user === 'string' ? [body.user] : []
    if (!users.length) return c.json({ error: { code: 'invalid_input', message: 'users (emails or user ids) is required' } }, 400)
    const conversation = await resolveAgentConversation(auth.workspaceId, c.req.param('channel'), projectId)
    if (!conversation) return c.json({ error: { code: 'not_found', message: 'Channel not found or not visible to this agent' } }, 404)
    try {
      const { addUserMembersAsAgent } = await import('../services/conversation.service')
      const added = await addUserMembersAsAgent(conversation, users.slice(0, 50))
      return c.json({ added, channel: { id: conversation.id, name: conversation.name } })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/dm`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    const projectId = await agentIdentity(auth, body.projectId)
    const limited = await rateLimited(c, `agent:${auth.workspaceId}:${projectId ?? 'ws'}`, CHAT_RATE_LIMITS.agentPost)
      ?? await rateLimited(c, `agent-dm:${auth.workspaceId}:${projectId ?? 'ws'}`, CHAT_RATE_LIMITS.dmOpen)
    if (limited) return limited
    const who = String(body.user ?? '').trim()
    if (!who) return c.json({ error: { code: 'invalid_input', message: 'user is required' } }, 400)
    const member = await db.member.findFirst({
      where: { workspaceId: auth.workspaceId, projectId: null, OR: [{ userId: who }, { user: { email: who.toLowerCase() } }] },
      select: { userId: true, user: { select: { name: true, email: true } } },
    })
    if (!member) return c.json({ error: { code: 'not_found', message: 'No workspace member matches that user' } }, 404)
    try {
      const onBehalfOfUserId = typeof body.onBehalfOfUserId === 'string' ? body.onBehalfOfUserId.trim() : ''
      let conversation
      let onBehalfOf: { userId: string; name: string } | undefined
      if (onBehalfOfUserId && onBehalfOfUserId !== member.userId) {
        const requester = await db.member.findFirst({
          where: { workspaceId: auth.workspaceId, projectId: null, userId: onBehalfOfUserId },
          select: { userId: true, user: { select: { name: true, email: true } } },
        })
        if (!requester) {
          return c.json({ error: { code: 'not_found', message: 'The requester is not a member of this workspace' } }, 404)
        }
        conversation = await openDirectConversation(auth.workspaceId, requester.userId, [member.userId])
        onBehalfOf = {
          userId: requester.userId,
          name: requester.user.name || requester.user.email,
        }
      } else {
        conversation = await openAgentConversation(auth.workspaceId, member.userId, { projectId })
      }
      const result = await postAgentMessage({
        conversationId: conversation.id,
        text: await resolveFriendlyMentions(auth.workspaceId, String(body.text ?? ''), projectId),
        agent: { projectId, name: await agentDisplayName(auth.workspaceId, projectId) },
        agentChain: await postChain(auth.workspaceId, projectId, body, null),
        ...(onBehalfOf ? { blocks: { onBehalfOf } } : {}),
      })
      void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
      return c.json({
        message: {
          id: result.message.id,
          conversationId: conversation.id,
          url: `${getFrontendUrl()}/c/${encodeURIComponent(conversation.id)}`,
        },
      }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}
