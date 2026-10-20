// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work boards API. `workBoardRoutes` serves people (session auth, mounted
 * under `/api`); `agentBoardRoutes` serves agent tools through the internal
 * runtime API, resolving channels and visibility the same way the
 * `agent-channels` routes do.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { ConversationError, getWorkspaceRole } from '../services/conversation.service'
import { resolveAgentConversation } from './conversations'
import {
  archiveBoard,
  archiveWorkItem,
  assertAgentCanWork,
  assertUserCanAdmin,
  assertUserCanWork,
  boardHealth,
  boardSummary,
  bulkUpdateWorkItems,
  commentWorkItem,
  createBoard,
  createColumn,
  createWorkItem,
  deleteColumn,
  getBoardView,
  getItemRow,
  getWorkItemDetail,
  getWorkItemHistory,
  linkWorkItem,
  listBoards,
  listWorkItems,
  moveWorkItem,
  problemOccurrences,
  registerWorkBoardHooks,
  reportProblem,
  reorderBoards,
  resolveBoard,
  updateBoard,
  updateColumn,
  updateWorkItem,
  type BoardActor,
  type BoardViewer,
  type HistoryFilter,
  type InboxFilter,
} from '../services/work-boards.service'
import { agentRefFor, normalizeAgentRef } from '../services/work-board-defaults'
import { attachmentIdsFrom, readAgentUpload, storeAgentAttachment } from '../services/agent-attachments'

const db = prisma as any

export interface WorkBoardRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

export interface AgentBoardAuthContext {
  workspaceId: string
  /** Set when a project-scoped token pins the agent. */
  projectId?: string
}

export interface AgentBoardRoutesConfig {
  authorize: (c: any) => Promise<AgentBoardAuthContext | Response>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof ConversationError) {
    return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status)
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

const strOr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const list = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

/** Accepts the snake_case names agent tools use and the camelCase the app sends. */
function pick(body: Record<string, any>, ...names: string[]): any {
  for (const n of names) if (body[n] !== undefined) return body[n]
  return undefined
}

function boardInput(body: Record<string, any>) {
  return {
    name: body.name,
    itemType: pick(body, 'itemType', 'item_type'),
    description: body.description,
    columns: Array.isArray(body.columns)
      ? body.columns.map((c: any) => (typeof c === 'string' ? { name: c } : {
          name: c?.name,
          category: c?.category,
          wipLimit: pick(c ?? {}, 'wipLimit', 'wip_limit'),
          agentRef: pick(c ?? {}, 'agentRef', 'agent', 'agent_ref'),
          slaHours: pick(c ?? {}, 'slaHours', 'sla_hours'),
        }))
      : undefined,
    fieldsSchema: pick(body, 'fieldsSchema', 'fields_schema', 'fields'),
    postToChannel: pick(body, 'postToChannel', 'post_to_channel'),
    requiresHumanReview: pick(body, 'requiresHumanReview', 'requires_human_review'),
    defaultAssigneeAgentRef: pick(body, 'defaultAssigneeAgentRef', 'default_assignee_agent', 'default_agent'),
    keyPrefix: pick(body, 'keyPrefix', 'key_prefix'),
    slug: body.slug,
    position: body.position,
    templateId: pick(body, 'templateId', 'template_id'),
    managedBy: pick(body, 'managedBy', 'managed_by'),
    systemManagedBy: pick(body, 'systemManagedBy', 'system'),
  }
}

function columnInput(body: Record<string, any>) {
  return {
    name: body.name,
    category: body.category,
    wipLimit: pick(body, 'wipLimit', 'wip_limit'),
    agentRef: pick(body, 'agentRef', 'agent', 'agent_ref'),
    slaHours: pick(body, 'slaHours', 'sla_hours'),
    // `rules: null` clears the rule, so it must survive this pick — `??` would
    // turn it into "no change".
    rules: 'rules' in body ? body.rules : (typeof body.allowAutoMerge === 'boolean' ? { allowAutoMerge: body.allowAutoMerge } : undefined),
    position: body.position,
    after: body.after,
    before: body.before,
  }
}

function itemInput(body: Record<string, any>) {
  return {
    title: body.title,
    description: body.description,
    column: body.column,
    fields: body.fields,
    priority: body.priority,
    assigneeUserId: pick(body, 'assigneeUserId', 'assignee_user', 'assignee_user_id'),
    assigneeAgentRef: pick(body, 'assigneeAgentRef', 'assignee_agent'),
    dueAt: pick(body, 'dueAt', 'due_at'),
    goalId: pick(body, 'goalId', 'goal_id'),
    projectId: pick(body, 'linkedProjectId', 'project_link'),
    externalRef: pick(body, 'externalRef', 'external_ref'),
    fingerprint: body.fingerprint,
    originMessageId: pick(body, 'originMessageId', 'origin_message_id', 'from_message'),
  }
}

function itemPatch(body: Record<string, any>) {
  const out: Record<string, any> = {}
  const map: Array<[string, string[]]> = [
    ['title', ['title']],
    ['description', ['description']],
    ['fields', ['fields']],
    ['priority', ['priority']],
    ['assigneeUserId', ['assigneeUserId', 'assignee_user', 'assignee_user_id']],
    ['assigneeAgentRef', ['assigneeAgentRef', 'assignee_agent']],
    ['dueAt', ['dueAt', 'due_at']],
    ['goalId', ['goalId', 'goal_id']],
    ['projectId', ['linkedProjectId', 'project_link']],
    ['externalRef', ['externalRef', 'external_ref']],
    ['historySummary', ['historySummary', 'history_summary']],
  ]
  for (const [key, names] of map) {
    const v = pick(body, ...names)
    if (v !== undefined) out[key] = v
  }
  return out
}

function moveInput(body: Record<string, any>) {
  return { column: body.column, board: body.board, after: body.after, before: body.before, position: body.position }
}

function inboxFilter(q: (k: string) => string | undefined, me: { userId?: string; agentRef?: string }): InboxFilter {
  const assignee = q('assignee')
  const filter: InboxFilter = {
    boardId: q('board') || q('boardId'),
    conversationId: q('conversationId'),
    categories: list(q('category') ?? q('categories')),
    priority: list(q('priority')),
    itemType: q('itemType') ?? q('item_type'),
    q: q('q'),
    sort: (['priority', 'activity', 'due', 'created'] as const).find((s) => s === q('sort')),
    limit: Number(q('limit')) || undefined,
    includeClosed: q('includeClosed') === 'true' || q('include_closed') === 'true',
  }
  if (assignee === 'me') {
    if (me.userId) filter.assigneeUserId = me.userId
    if (me.agentRef) filter.assigneeAgentRef = me.agentRef
  } else if (assignee === 'none' || assignee === 'unassigned') {
    filter.unassigned = true
  } else if (assignee) {
    const ref = normalizeAgentRef(assignee)
    if (assignee.startsWith('user:')) filter.assigneeUserId = assignee.slice(5)
    else if (ref && (assignee === 'workspace' || assignee.startsWith('project:'))) filter.assigneeAgentRef = ref
    else filter.assigneeUserId = assignee
  }
  return filter
}

// ─── People ──────────────────────────────────────────────────────────────────

export function workBoardRoutes(config: WorkBoardRoutesConfig): Hono {
  const router = new Hono()
  registerWorkBoardHooks()

  async function requireUser(c: any): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    return userId
  }

  async function requireMember(c: any, workspaceId: string): Promise<string | Response> {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    if (!(await getWorkspaceRole(workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    }
    return userId
  }

  /** A board the user can see, by id. */
  async function boardFor(c: any, userId: string) {
    const board = await db.board.findUnique({ where: { id: c.req.param('boardId') }, include: { columns: true } })
    if (!board) throw new ConversationError(404, 'not_found', 'Board not found')
    const viewer: BoardViewer = { kind: 'user', userId }
    const visible = await listBoards(board.workspaceId, viewer, { conversationId: board.conversationId, includeArchived: true })
    if (!visible.some((b) => b.id === board.id)) throw new ConversationError(404, 'not_found', 'Board not found')
    return board
  }

  async function itemFor(c: any, userId: string) {
    const row = await db.workItem.findUnique({ where: { id: c.req.param('itemId') }, select: { workspaceId: true, boardId: true } })
    if (!row) throw new ConversationError(404, 'not_found', 'Card not found')
    const item = await getItemRow(row.workspaceId, c.req.param('itemId'))
    const visible = await listBoards(item.workspaceId, { kind: 'user', userId }, { conversationId: item.board.conversationId, includeArchived: true })
    if (!visible.some((b) => b.id === item.boardId)) throw new ConversationError(404, 'not_found', 'Card not found')
    return item
  }

  const actorFor = (userId: string): BoardActor => ({ userId })

  router.get('/workspaces/:workspaceId/boards', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const conversationId = c.req.query('conversationId')
    const boards = await listBoards(workspaceId, { kind: 'user', userId }, {
      ...(conversationId !== undefined ? { conversationId: conversationId === 'none' ? null : conversationId } : {}),
      includeArchived: c.req.query('includeArchived') === 'true',
    })
    return c.json({ boards })
  })

  router.post('/workspaces/:workspaceId/boards', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const conversationId = strOr(body.conversationId) ?? null
      if (conversationId) await assertUserCanWork({ workspaceId, conversationId }, userId)
      else if ((await getWorkspaceRole(workspaceId, userId)) === 'viewer') {
        return c.json({ error: { code: 'forbidden', message: 'Viewers cannot create boards' } }, 403)
      }
      const board = await createBoard(workspaceId, { ...boardInput(body), conversationId, managedBy: 'user', systemManagedBy: null }, actorFor(userId))
      return c.json({ board }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.put('/workspaces/:workspaceId/boards/order', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const conversationId = strOr(body.conversationId) ?? null
      await assertUserCanWork({ workspaceId, conversationId }, userId)
      return c.json({ order: await reorderBoards(workspaceId, conversationId, list(body.boardIds) ?? []) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/boards/health', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json(await boardHealth(workspaceId, { kind: 'user', userId }, {
      boardId: c.req.query('boardId'),
      conversationId: c.req.query('conversationId'),
      staleHours: Number(c.req.query('staleHours')) || undefined,
    }))
  })

  router.get('/boards/:boardId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      const board = await boardFor(c, userId)
      return c.json(await getBoardView(board, {
        includeArchived: c.req.query('includeArchived') === 'true',
        assigneeUserId: c.req.query('assignee') === 'me' ? userId : undefined,
        priority: c.req.query('priority'),
        q: c.req.query('q'),
      }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/boards/:boardId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const board = await boardFor(c, userId)
      await assertUserCanAdmin(board, userId)
      const { columns: _columns, managedBy: _m, systemManagedBy: _s, templateId: _t, slug: _slug, ...patch } = boardInput(body)
      const clean = Object.fromEntries(Object.entries({ ...patch, conversationId: body.conversationId }).filter(([, v]) => v !== undefined))
      return c.json({ board: await updateBoard(board, clean) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/boards/:boardId/archive', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const board = await boardFor(c, userId)
      await assertUserCanAdmin(board, userId)
      return c.json({ board: await archiveBoard(board, body.archived !== false) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/boards/:boardId/summary', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await boardSummary(await boardFor(c, userId), { days: Number(c.req.query('days')) || undefined }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/boards/:boardId/columns', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const board = await boardFor(c, userId)
      await assertUserCanAdmin(board, userId)
      return c.json(await createColumn(board, columnInput(body)), 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/boards/:boardId/columns/:columnId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const board = await boardFor(c, userId)
      await assertUserCanAdmin(board, userId)
      const patch = Object.fromEntries(Object.entries(columnInput(body)).filter(([, v]) => v !== undefined))
      return c.json(await updateColumn(board, c.req.param('columnId'), patch))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/boards/:boardId/columns/:columnId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      const board = await boardFor(c, userId)
      await assertUserCanAdmin(board, userId)
      return c.json(await deleteColumn(board, c.req.param('columnId'), c.req.query('moveTo') || undefined, actorFor(userId)))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/boards/:boardId/items', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const board = await boardFor(c, userId)
      await assertUserCanWork(board, userId)
      const source = body.originMessageId ? 'message' : 'manual'
      return c.json({ item: await createWorkItem(board, { ...itemInput(body), source }, actorFor(userId)) }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /** "Create card from message": the message is quoted and linked as the card's origin. */
  router.post('/conversation-messages/:messageId/card', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const message = await db.conversationMessage.findUnique({ where: { id: c.req.param('messageId') }, select: { id: true, workspaceId: true, conversationId: true, text: true } })
      if (!message) throw new ConversationError(404, 'not_found', 'Message not found')
      await assertUserCanWork({ workspaceId: message.workspaceId, conversationId: message.conversationId }, userId)
      const ref = strOr(body.boardId) ?? strOr(body.board)
      if (!ref) throw new ConversationError(400, 'invalid_board', 'Pick a board')
      const board = await resolveBoard(message.workspaceId, ref, message.conversationId)
      await assertUserCanWork(board, userId)
      const firstLine = String(message.text ?? '').split('\n')[0].replace(/<[@#!][^>]+>/g, '').slice(0, 120).trim()
      const title = strOr(body.title) ?? (firstLine || 'Untitled')
      const item = await createWorkItem(board, { ...itemInput(body), title, originMessageId: message.id, source: 'message' }, actorFor(userId))
      return c.json({ item }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/work-items', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json(await listWorkItems(workspaceId, { kind: 'user', userId }, inboxFilter((k) => c.req.query(k), { userId })))
  })

  router.post('/workspaces/:workspaceId/work-items/bulk', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    const ids = list(body.ids) ?? []
    if (!ids.length) return c.json({ error: { code: 'invalid_input', message: 'ids is required' } }, 400)
    const patch = { ...itemPatch(body.patch ?? body), column: (body.patch ?? body).column, archived: (body.patch ?? body).archived }
    return c.json(await bulkUpdateWorkItems(workspaceId, ids, patch, actorFor(userId), (item) => assertUserCanWork(item.board, userId)))
  })

  router.get('/work-items/:itemId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await getWorkItemDetail(await itemFor(c, userId), { kind: 'user', userId }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/work-items/:itemId', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      await assertUserCanWork(item.board, userId)
      return c.json({ item: await updateWorkItem(item, itemPatch(body), actorFor(userId)) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/work-items/:itemId/move', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      await assertUserCanWork(item.board, userId)
      if (body.board) await assertUserCanWork(await resolveBoard(item.workspaceId, String(body.board)), userId)
      return c.json(await moveWorkItem(item, moveInput(body), actorFor(userId)))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/work-items/:itemId/comments', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      await assertUserCanWork(item.board, userId)
      return c.json(await commentWorkItem(item, String(body.text ?? ''), actorFor(userId)), 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/work-items/:itemId/archive', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      await assertUserCanWork(item.board, userId)
      return c.json({ item: await archiveWorkItem(item, body.archived !== false, actorFor(userId)) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/work-items/:itemId/links', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      await assertUserCanWork(item.board, userId)
      const link = await linkWorkItem(item, { kind: body.kind ?? 'message', refId: body.refId ?? body.messageId, url: body.url, snippet: body.snippet, reason: 'manual' }, actorFor(userId))
      return c.json({ link }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/work-items/:itemId/history', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      const item = await itemFor(c, userId)
      return c.json(await getWorkItemHistory(item, { kind: 'user', userId }, {
        limit: Number(c.req.query('limit')) || undefined,
        before: c.req.query('before'),
        filter: (c.req.query('filter') as HistoryFilter) || 'all',
      }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/work-items/:itemId/occurrences', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    try {
      const item = await itemFor(c, userId)
      return c.json(await problemOccurrences(item, { limit: Number(c.req.query('limit')) || undefined, days: Number(c.req.query('days')) || undefined }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/work-items/:itemId/follow', async (c) => {
    const userId = await requireUser(c)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const item = await itemFor(c, userId)
      if (body.following === false) {
        await db.workItemSubscription.deleteMany({ where: { workItemId: item.id, userId } })
      } else {
        await db.workItemSubscription.upsert({
          where: { workItemId_userId: { workItemId: item.id, userId } },
          create: { workItemId: item.id, userId },
          update: {},
        })
      }
      return c.json({ following: body.following !== false })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export function agentBoardRoutes(config: AgentBoardRoutesConfig): Hono {
  const router = new Hono()
  registerWorkBoardHooks()
  const base = '/workspaces/:workspaceId/agent-boards'
  const items = '/workspaces/:workspaceId/agent-work-items'

  async function agentIdentity(auth: AgentBoardAuthContext, claimed: unknown): Promise<string | null> {
    if (auth.projectId !== undefined) return auth.projectId
    if (typeof claimed !== 'string' || !claimed) return null
    const project = await db.project.findUnique({ where: { id: claimed }, select: { workspaceId: true } })
    return project?.workspaceId === auth.workspaceId ? claimed : null
  }

  async function context(c: any, body?: Record<string, any>) {
    const auth = await config.authorize(c)
    if (auth instanceof Response) return auth
    const projectId = await agentIdentity(auth, body?.projectId ?? c.req.query('projectId'))
    const actor: BoardActor = {
      agentRef: agentRefFor(projectId),
      sessionId: strOr(body?.sessionId) ?? strOr(c.req.query('sessionId')) ?? null,
      userId: strOr(body?.onBehalfOfUserId) ?? null,
    }
    const viewer: BoardViewer = { kind: 'agent', projectId }
    return { auth, projectId, actor, viewer }
  }

  async function channelId(workspaceId: string, projectId: string | null, ref: unknown): Promise<string | null | undefined> {
    const name = strOr(ref)
    if (!name) return undefined
    const conversation = await resolveAgentConversation(workspaceId, name, projectId)
    if (!conversation) throw new ConversationError(404, 'not_found', `Channel "${name}" not found or not visible to this agent`)
    return conversation.id
  }

  async function board(c: any, workspaceId: string, projectId: string | null, ref: string) {
    const channel = await channelId(workspaceId, projectId, c.req.query('channel'))
    const row = await resolveBoard(workspaceId, ref, channel ?? undefined)
    await assertAgentCanWork(row, projectId)
    return row
  }

  async function item(workspaceId: string, projectId: string | null, ref: string) {
    const row = await getItemRow(workspaceId, ref)
    await assertAgentCanWork(row.board, projectId)
    return row
  }

  router.get(base, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const conversationId = await channelId(ctx.auth.workspaceId, ctx.projectId, c.req.query('channel'))
      const boards = await listBoards(ctx.auth.workspaceId, ctx.viewer, {
        ...(conversationId !== undefined ? { conversationId } : {}),
        includeArchived: c.req.query('includeArchived') === 'true',
      })
      return c.json({ boards })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(base, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const conversationId = (await channelId(ctx.auth.workspaceId, ctx.projectId, body.channel)) ?? null
      const input = boardInput(body)
      const created = await createBoard(ctx.auth.workspaceId, {
        ...input,
        conversationId,
        managedBy: input.systemManagedBy ? 'manifest' : 'user',
        systemManagedBy: strOr(input.systemManagedBy) ?? null,
      }, ctx.actor)
      return c.json({ board: created }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.put(`${base}/order`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const conversationId = (await channelId(ctx.auth.workspaceId, ctx.projectId, body.channel)) ?? null
      const ids: string[] = []
      for (const ref of list(body.boards) ?? []) ids.push((await resolveBoard(ctx.auth.workspaceId, ref, conversationId)).id)
      return c.json({ order: await reorderBoards(ctx.auth.workspaceId, conversationId, ids) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(`${base}/health`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const conversationId = await channelId(ctx.auth.workspaceId, ctx.projectId, c.req.query('channel'))
      const boardRef = strOr(c.req.query('board'))
      const boardId = boardRef ? (await resolveBoard(ctx.auth.workspaceId, boardRef, conversationId ?? undefined)).id : undefined
      return c.json(await boardHealth(ctx.auth.workspaceId, ctx.viewer, {
        boardId,
        conversationId: conversationId ?? undefined,
        staleHours: Number(c.req.query('staleHours')) || undefined,
      }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(`${base}/:board`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json(await getBoardView(row, { q: c.req.query('q'), priority: c.req.query('priority') }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch(`${base}/:board`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      const { columns: _c, templateId: _t, slug: _s, ...patch } = boardInput(body)
      const conversationId = body.channel !== undefined ? (await channelId(ctx.auth.workspaceId, ctx.projectId, body.channel)) ?? null : undefined
      const clean = Object.fromEntries(Object.entries({ ...patch, conversationId }).filter(([, v]) => v !== undefined))
      return c.json({ board: await updateBoard(row, clean) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/:board/archive`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json({ board: await archiveBoard(row, body.archived !== false) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(`${base}/:board/summary`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json(await boardSummary(row, { days: Number(c.req.query('days')) || undefined }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/:board/columns`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json(await createColumn(row, columnInput(body)), 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch(`${base}/:board/columns/:column`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      const patch = Object.fromEntries(Object.entries(columnInput(body)).filter(([, v]) => v !== undefined))
      return c.json(await updateColumn(row, decodeURIComponent(c.req.param('column')), patch))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete(`${base}/:board/columns/:column`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json(await deleteColumn(row, decodeURIComponent(c.req.param('column')), c.req.query('move_to') || c.req.query('moveTo') || undefined, ctx.actor))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/:board/items`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      return c.json({ item: await createWorkItem(row, { ...itemInput(body), source: 'agent' }, ctx.actor) }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(items, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const conversationId = await channelId(ctx.auth.workspaceId, ctx.projectId, c.req.query('channel'))
      const filter = inboxFilter((k) => c.req.query(k), { agentRef: ctx.actor.agentRef ?? undefined })
      if (conversationId) filter.conversationId = conversationId
      if (filter.boardId) filter.boardId = (await resolveBoard(ctx.auth.workspaceId, filter.boardId, conversationId ?? undefined)).id
      const result = await listWorkItems(ctx.auth.workspaceId, ctx.viewer, filter)
      return c.json({ items: result.items })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${items}/bulk`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    const ids = list(body.ids ?? body.items) ?? []
    if (!ids.length) return c.json({ error: { code: 'invalid_input', message: 'ids is required' } }, 400)
    const source = body.patch ?? body
    const patch = { ...itemPatch(source), column: source.column, archived: source.archived }
    return c.json(await bulkUpdateWorkItems(ctx.auth.workspaceId, ids, patch, ctx.actor, (it) => assertAgentCanWork(it.board, ctx.projectId)))
  })

  router.get(`${items}/:item`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      return c.json(await getWorkItemDetail(await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item')), ctx.viewer))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch(`${items}/:item`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      return c.json({ item: await updateWorkItem(row, itemPatch(body), ctx.actor) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${items}/:item/move`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      if (body.board) await assertAgentCanWork(await resolveBoard(ctx.auth.workspaceId, String(body.board)), ctx.projectId)
      return c.json(await moveWorkItem(row, moveInput(body), ctx.actor))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${items}/:item/comments`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      return c.json(await commentWorkItem(row, String(body.text ?? ''), ctx.actor, {
        projectId: ctx.projectId,
        attachmentIds: attachmentIdsFrom(body.attachmentIds),
      }), 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /**
   * An agent uploads an image or video for a card: to attach to a comment
   * (`attachmentIds`) or to embed in the description by its returned url.
   * Files live in the board's channel, next to the card thread.
   */
  async function uploadForBoard(c: any, resolve: (ctx: { auth: AgentBoardAuthContext; projectId: string | null }) => Promise<any>) {
    try {
      const { file, form } = await readAgentUpload(c)
      const ctx = await context(c, { projectId: form.get('projectId'), sessionId: form.get('sessionId') })
      if (ctx instanceof Response) return ctx
      const boardRow = await resolve(ctx)
      if (!boardRow?.conversationId) {
        return c.json({ error: { code: 'no_channel', message: 'This board has no channel to keep files in' } }, 409)
      }
      const attachment = await storeAgentAttachment({
        workspaceId: ctx.auth.workspaceId,
        conversationId: boardRow.conversationId,
        agentRef: ctx.actor.agentRef ?? agentRefFor(ctx.projectId),
        file,
      })
      return c.json({ attachment }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  }

  router.post(`${base}/:board/attachments`, (c) =>
    uploadForBoard(c, (ctx) => board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))))

  router.post(`${items}/:item/attachments`, (c) =>
    uploadForBoard(c, async (ctx) => (await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))).board))

  router.post(`${items}/:item/archive`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      return c.json({ item: await archiveWorkItem(row, body.archived !== false, ctx.actor) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${items}/:item/links`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      const link = await linkWorkItem(row, {
        kind: body.kind ?? 'message',
        refId: body.ref_id ?? body.refId ?? body.message_id,
        url: body.url,
        snippet: body.snippet,
        reason: body.reason === 'escalation' || body.reason === 'sync' ? body.reason : 'manual',
      }, ctx.actor)
      return c.json({ link }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(`${items}/:item/history`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      return c.json(await getWorkItemHistory(row, ctx.viewer, {
        limit: Number(c.req.query('limit')) || undefined,
        before: c.req.query('before'),
        filter: (c.req.query('filter') as HistoryFilter) || 'all',
      }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post(`${base}/:board/problems`, async (c) => {
    const body = await readJson(c)
    const ctx = await context(c, body)
    if (ctx instanceof Response) return ctx
    try {
      const row = await board(c, ctx.auth.workspaceId, ctx.projectId, c.req.param('board'))
      const result = await reportProblem(row, {
        title: body.title,
        fingerprint: body.fingerprint,
        environment: body.environment,
        release: body.release,
        message: body.message,
        stack: body.stack,
        url: body.url,
        userRef: body.user_ref ?? body.userRef,
        context: body.context && typeof body.context === 'object' ? body.context : null,
        occurredAt: body.occurred_at ?? body.occurredAt,
      }, ctx.actor)
      return c.json(result, result.outcome === 'new' ? 201 : 200)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get(`${items}/:item/occurrences`, async (c) => {
    const ctx = await context(c)
    if (ctx instanceof Response) return ctx
    try {
      const row = await item(ctx.auth.workspaceId, ctx.projectId, c.req.param('item'))
      return c.json(await problemOccurrences(row, { limit: Number(c.req.query('limit')) || undefined, days: Number(c.req.query('days')) || undefined }))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}
