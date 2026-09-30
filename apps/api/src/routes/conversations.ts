// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace channels API: conversations, members, messages, threads,
 * reactions, files, read state, and the realtime socket/SSE endpoints.
 *
 * Mounted under `/api` for both the cloud and desktop composers.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { canReceive, subscribeWorkspaceEvents } from '../lib/conversation-bus'
import {
  MAX_CONVERSATION_FILE_BYTES,
  buildConversationFileKey,
  conversationFileUrl,
  putConversationFile,
  readConversationFile,
  verifyConversationFileToken,
} from '../lib/conversation-files'
import {
  ConversationError,
  addAgentMember,
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
import { catchUp } from '../services/conversation-activity'
import { stopAgentReply } from '../services/conversation-agent-dispatcher'
import { getPresence } from '../services/conversation-presence'
import { getChannelMetrics } from '../services/conversation-metrics'
import { searchMessages } from '../services/conversation-search'
import { registerConversationNotifications } from '../services/conversation-notifications'
import { registerConversationUnfurls } from '../services/conversation-unfurl'
import { listStatuses } from '../services/chat-settings'
import { listGroups } from '../services/chat-customization'
import { mountConversationExtras } from './conversation-extras'
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

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
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
    return { userId, workspaceId }
  }

  mountConversationExtras(router, { requireUser, requireWorkspace, errorResponse, readJson })

  // ─── Workspace-level ─────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/conversations', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ conversations: await listConversationsForUser(auth.workspaceId, auth.userId) })
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
    const body = await readJson(c)
    try {
      const conversation = body.agent && typeof body.agent === 'object'
        ? await openAgentConversation(auth.workspaceId, auth.userId, {
            projectId: typeof body.agent.projectId === 'string' ? body.agent.projectId : null,
          })
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
      listMentionables(auth.workspaceId),
      listStatuses(auth.workspaceId),
      listGroups(auth.workspaceId),
    ])
    return c.json({ ...mentionables, statuses, groups })
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
    return c.json(await searchMessages(auth.workspaceId, auth.userId, c.req.query('q') ?? '', {
      limit: numberParam(c.req.query('limit')),
      offset: numberParam(c.req.query('offset')),
      sort: c.req.query('sort') === 'recent' ? 'recent' : 'relevance',
    }))
  })

  router.get('/workspaces/:workspaceId/conversations/metrics', async (c) => {
    const auth = await requireWorkspace(c)
    if (auth instanceof Response) return auth
    const role = await getWorkspaceRole(auth.workspaceId, auth.userId)
    if (role !== 'owner' && role !== 'admin') {
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
      await putConversationFile(key, new Uint8Array(await file.arrayBuffer()), mimeType)
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

  // ─── Files (capability URL) ──────────────────────────────────────────────

  router.get('/conversation-files/:attachmentId', async (c) => {
    const id = c.req.param('attachmentId')
    const row = await db.conversationAttachment.findUnique({ where: { id } })
    if (!row) return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
    let allowed = verifyConversationFileToken(id, c.req.query('t'))
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

async function resolveAgentConversation(workspaceId: string, channel: string, projectId: string | null) {
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
    projects: new Map<string, string>(projects.map((p: any) => [p.id, p.name])),
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

export function agentChannelRoutes(config: AgentChannelRoutesConfig): Hono {
  const router = new Hono()
  const base = '/workspaces/:workspaceId/agent-channels'

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

  router.get(`${base}/search`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
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
    const conversation = await resolveAgentConversation(auth.workspaceId, c.req.param('channel'), projectId)
    if (!conversation || conversation.kind === 'activity' || conversation.archivedAt) {
      return c.json({ error: { code: 'not_found', message: 'Channel not found or not open to agent posts' } }, 404)
    }
    try {
      const result = await postMessage({
        conversationId: conversation.id,
        text: String(body.text ?? ''),
        authorType: 'agent',
        authorAgentRef: { projectId, name: await agentDisplayName(auth.workspaceId, projectId) },
        threadRootId: typeof body.threadRootId === 'string' ? body.threadRootId : null,
        agentStatus: 'done',
      })
      void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
      return c.json({ message: { id: result.message.id, conversationId: conversation.id } }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/dm`, async (c) => {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    const projectId = await agentIdentity(auth, body.projectId)
    const who = String(body.user ?? '').trim()
    if (!who) return c.json({ error: { code: 'invalid_input', message: 'user is required' } }, 400)
    const member = await db.member.findFirst({
      where: { workspaceId: auth.workspaceId, OR: [{ userId: who }, { user: { email: who.toLowerCase() } }] },
      select: { userId: true },
    })
    if (!member) return c.json({ error: { code: 'not_found', message: 'No workspace member matches that user' } }, 404)
    try {
      const conversation = await openAgentConversation(auth.workspaceId, member.userId, { projectId })
      const result = await postMessage({
        conversationId: conversation.id,
        text: String(body.text ?? ''),
        authorType: 'agent',
        authorAgentRef: { projectId, name: await agentDisplayName(auth.workspaceId, projectId) },
        agentStatus: 'done',
      })
      void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
      return c.json({ message: { id: result.message.id, conversationId: conversation.id } }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}
