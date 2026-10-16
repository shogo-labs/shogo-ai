// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work boards: Kanban boards that live in channels (several per channel),
 * their columns, and the cards on them.
 *
 * A card's conversation is a thread in its board's channel. The thread root is
 * a system message carrying a status card and an agent chain whose `runId` is
 * the card id, so any agent woken in the thread knows which card it is on.
 * Everything else a card touches (mentions elsewhere, agent sessions, external
 * threads, PRs) is recorded as a WorkItemLink; every change is a WorkItemEvent.
 *
 * Assigning a card to an agent, or moving it into a column with an agent, wakes
 * that agent in the card thread through the normal channel reply path.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { getFrontendUrl } from '../lib/cloud-urls'
import {
  ConversationError,
  agentDisplayName,
  conversationAudience,
  getWorkspaceRole,
  loadAccess,
  canPost,
  canManage,
  postMessage,
  updateMessageInternal,
} from './conversation.service'
import { agentMentionToken } from './conversation-mentions'
import { blocksForKind, type StatusCard } from './conversation-message-kind'
import { registerAfterPostHook, afterMessagePosted } from './conversation-pipeline'
import {
  COLUMN_CATEGORIES,
  DEFAULT_COLUMNS,
  ITEM_SOURCES,
  ITEM_TYPES,
  LINK_KINDS,
  LINK_REASONS,
  POST_TO_CHANNEL,
  PRIORITIES,
  agentRefFor,
  agentRefProjectId,
  cardKeysIn,
  cardStatusFor,
  hoursBetween,
  isClosed,
  keyPrefixFor,
  normalizeAgentRef,
  normalizeFieldsSchema,
  normalizeKeyPrefix,
  oneOf,
  slugify,
  type ColumnCategory,
  type ItemType,
} from './work-board-defaults'

const db = prisma as any

/** Who is making a change. Agents act for `userId` when a person started the run. */
export interface BoardActor {
  userId?: string | null
  agentRef?: string | null
  sessionId?: string | null
}

/** Who is reading. Agents see what their channel membership allows. */
export type BoardViewer = { kind: 'user'; userId: string } | { kind: 'agent'; projectId: string | null }

const MAX_BULK = 100
const MAX_AGENT_WAKES_PER_HOUR = 8
const MAX_ITEMS_PER_BOARD_VIEW = 500

const bad = (code: string, message: string) => new ConversationError(400, code, message)
const notFound = (what: string) => new ConversationError(404, 'not_found', `${what} not found`)
const forbidden = (message: string) => new ConversationError(403, 'forbidden', message)

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

function dateOrNull(value: unknown): Date | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

// ─── Serialization ───────────────────────────────────────────────────────────

export function serializeColumn(c: any) {
  return {
    id: c.id,
    name: c.name,
    position: c.position,
    category: c.category,
    wipLimit: c.wipLimit ?? null,
    agentRef: c.agentRef ?? null,
    slaHours: c.slaHours ?? null,
  }
}

export function serializeBoard(b: any) {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    conversationId: b.conversationId ?? null,
    name: b.name,
    slug: b.slug,
    keyPrefix: b.keyPrefix,
    position: b.position,
    itemType: b.itemType,
    description: b.description ?? null,
    fieldsSchema: b.fieldsSchema ?? [],
    postToChannel: b.postToChannel,
    requiresHumanReview: b.requiresHumanReview,
    defaultAssigneeAgentRef: b.defaultAssigneeAgentRef ?? null,
    managedBy: b.managedBy,
    systemManagedBy: b.systemManagedBy ?? null,
    templateId: b.templateId ?? null,
    archivedAt: b.archivedAt ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    columns: (b.columns ?? []).slice().sort((x: any, y: any) => x.position - y.position).map(serializeColumn),
  }
}

export function serializeItem(i: any) {
  return {
    id: i.id,
    key: i.key,
    number: i.number,
    workspaceId: i.workspaceId,
    boardId: i.boardId,
    columnId: i.columnId,
    position: i.position,
    title: i.title,
    description: i.description ?? null,
    fields: i.fields ?? {},
    priority: i.priority,
    assigneeUserId: i.assigneeUserId ?? null,
    assigneeAgentRef: i.assigneeAgentRef ?? null,
    dueAt: i.dueAt ?? null,
    goalId: i.goalId ?? null,
    projectId: i.projectId ?? null,
    conversationId: i.conversationId ?? null,
    threadRootMessageId: i.threadRootMessageId ?? null,
    source: i.source,
    externalRef: i.externalRef ?? null,
    fingerprint: i.fingerprint ?? null,
    historySummary: i.historySummary ?? null,
    columnEnteredAt: i.columnEnteredAt,
    lastActivityAt: i.lastActivityAt,
    completedAt: i.completedAt ?? null,
    archivedAt: i.archivedAt ?? null,
    createdById: i.createdById ?? null,
    createdByAgentRef: i.createdByAgentRef ?? null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ...(i.column ? { column: { id: i.column.id, name: i.column.name, category: i.column.category, ...(i.column.agentRef ? { agentRef: i.column.agentRef } : {}) } } : {}),
    ...(i.board ? { board: { id: i.board.id, name: i.board.name, slug: i.board.slug, conversationId: i.board.conversationId ?? null, itemType: i.board.itemType } } : {}),
  }
}

/** App path for a card: its thread in the channel, or the inbox for cards without one. */
export function itemPath(item: { id: string; conversationId?: string | null; threadRootMessageId?: string | null }): string {
  if (item.conversationId && item.threadRootMessageId) {
    return `/c/${encodeURIComponent(item.conversationId)}?thread=${encodeURIComponent(item.threadRootMessageId)}&card=${encodeURIComponent(item.id)}`
  }
  return `/work?card=${encodeURIComponent(item.id)}`
}

export function itemUrl(item: { id: string; conversationId?: string | null; threadRootMessageId?: string | null }): string {
  return `${getFrontendUrl()}${itemPath(item)}`
}

async function workActivity(kind: 'work.created' | 'work.done' | 'work.regressed', item: any, board: any, actor: BoardActor, ref: string) {
  const { recordWorkItemActivity } = await import('./conversation-activity')
  await recordWorkItemActivity(kind, {
    item,
    board,
    actor: await actorLabel(item.workspaceId, actor),
    link: itemPath(item),
    projectId: actor.agentRef ? agentRefProjectId(actor.agentRef) : null,
    actorUserId: actor.agentRef ? null : actor.userId ?? null,
    ref,
  })
}

// ─── Access ──────────────────────────────────────────────────────────────────

async function publishBoard(board: { id: string; workspaceId: string; conversationId?: string | null }, event: Record<string, unknown>) {
  let audience: string[] | null = null
  if (board.conversationId) {
    const conversation = await db.conversation.findUnique({ where: { id: board.conversationId }, select: { id: true, kind: true } })
    if (conversation) audience = await conversationAudience(conversation)
  }
  publishConversationEvent(board.workspaceId, { type: 'board.changed', boardId: board.id, conversationId: board.conversationId ?? undefined, ...event }, audience)
}

/** Whether a reader can see a board: its channel's read rule, or workspace membership for channel-less boards. */
async function canViewBoard(board: any, viewer: BoardViewer): Promise<boolean> {
  if (viewer.kind === 'user') {
    if (!board.conversationId) return !!(await getWorkspaceRole(board.workspaceId, viewer.userId))
    try {
      await loadAccess(board.conversationId, viewer.userId)
      return true
    } catch {
      return false
    }
  }
  if (!board.conversationId) return true
  return agentCanSeeConversation(board.conversationId, viewer.projectId)
}

async function agentCanSeeConversation(conversationId: string, projectId: string | null): Promise<boolean> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true } })
  if (!conversation) return false
  if (conversation.kind === 'public' || conversation.kind === 'activity') return true
  return !!(await db.conversationMember.findFirst({
    where: { conversationId, memberType: 'agent', projectId },
    select: { id: true },
  }))
}

/** People who can post in the channel work its cards; viewers only read. */
export async function assertUserCanWork(board: any, userId: string): Promise<void> {
  if (!board.conversationId) {
    const role = await getWorkspaceRole(board.workspaceId, userId)
    if (!role) throw notFound('Board')
    if (role === 'viewer') throw forbidden('Viewers cannot change cards')
    return
  }
  let access
  try {
    access = await loadAccess(board.conversationId, userId)
  } catch {
    throw notFound('Board')
  }
  if (!canPost(access, { threadReply: true })) throw forbidden('You cannot change cards in this channel')
}

/** Board structure: channel managers, workspace admins, or the person who made the board. */
export async function assertUserCanAdmin(board: any, userId: string): Promise<void> {
  await assertUserCanWork(board, userId)
  if (board.createdById === userId) return
  const role = await getWorkspaceRole(board.workspaceId, userId)
  if (role === 'owner' || role === 'admin') return
  if (board.conversationId) {
    const access = await loadAccess(board.conversationId, userId)
    if (canManage(access)) return
  }
  throw forbidden('Only the board’s creator, channel owners and workspace admins can change its structure')
}

export async function assertAgentCanWork(board: any, projectId: string | null): Promise<void> {
  if (!(await canViewBoard(board, { kind: 'agent', projectId }))) throw notFound('Board')
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

const BOARD_INCLUDE = { columns: true }

export async function getBoardRow(workspaceId: string, ref: string): Promise<any> {
  const r = ref.trim()
  const board = await db.board.findFirst({
    where: { workspaceId, OR: [{ id: r }, { slug: r.toLowerCase() }] },
    include: BOARD_INCLUDE,
  })
  if (!board) throw notFound(`Board "${ref}"`)
  return board
}

/** Boards by name too, within a channel when given: "Pipeline" in #sales. */
export async function resolveBoard(workspaceId: string, ref: string, conversationId?: string | null): Promise<any> {
  const r = ref.trim()
  const direct = await db.board.findFirst({
    where: { workspaceId, OR: [{ id: r }, { slug: r.toLowerCase() }] },
    include: BOARD_INCLUDE,
  })
  if (direct) return direct
  const byName = await db.board.findMany({
    where: { workspaceId, archivedAt: null, ...(conversationId ? { conversationId } : {}) },
    include: BOARD_INCLUDE,
  })
  const hit = byName.find((b: any) => b.name.toLowerCase() === r.toLowerCase() || slugify(b.name) === slugify(r))
  if (!hit) throw notFound(`Board "${ref}"`)
  return hit
}

function resolveColumnIn(board: any, ref: unknown): any | undefined {
  if (typeof ref !== 'string' || !ref.trim()) return undefined
  const r = ref.trim().toLowerCase()
  const columns = (board.columns ?? []).slice().sort((a: any, b: any) => a.position - b.position)
  return columns.find((c: any) => c.id === ref)
    ?? columns.find((c: any) => c.name.toLowerCase() === r)
    ?? columns.find((c: any) => slugify(c.name) === slugify(r))
    ?? columns.find((c: any) => c.category === r)
}

function defaultColumn(board: any): any {
  const columns = (board.columns ?? []).slice().sort((a: any, b: any) => a.position - b.position)
  return columns.find((c: any) => c.category === 'backlog') ?? columns[0]
}

export async function getItemRow(workspaceId: string, ref: string): Promise<any> {
  const r = ref.trim()
  const item = await db.workItem.findFirst({
    where: { workspaceId, OR: [{ id: r }, { key: r.toUpperCase() }] },
    include: { column: true, board: { include: BOARD_INCLUDE } },
  })
  if (!item) throw notFound(`Card "${ref}"`)
  return item
}

async function uniqueSlug(workspaceId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base)
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? root : `${root}-${n}`
    const taken = await db.board.findFirst({ where: { workspaceId, slug, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true } })
    if (!taken) return slug
  }
  return `${root}-${crypto.randomUUID().slice(0, 6)}`
}

async function uniquePrefix(workspaceId: string, base: string, exceptId?: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const prefix = n === 1 ? base : `${base.slice(0, 5)}${n}`
    const taken = await db.board.findFirst({ where: { workspaceId, keyPrefix: prefix, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true } })
    if (!taken) return prefix
  }
  return `${base.slice(0, 3)}${Math.floor(Math.random() * 900 + 100)}`
}

async function workspaceOwnerId(workspaceId: string): Promise<string | null> {
  const owner = await db.member.findFirst({ where: { workspaceId, projectId: null, role: 'owner' }, select: { userId: true }, orderBy: { createdAt: 'asc' } })
  return owner?.userId ?? null
}

async function assigneeLabel(workspaceId: string, item: any): Promise<string> {
  if (item.assigneeAgentRef) return agentDisplayName(workspaceId, agentRefProjectId(item.assigneeAgentRef))
  if (item.assigneeUserId) {
    const u = await db.user.findUnique({ where: { id: item.assigneeUserId }, select: { name: true, email: true } })
    return u?.name || u?.email || 'Someone'
  }
  return 'Unassigned'
}

async function actorLabel(workspaceId: string, actor: BoardActor): Promise<string> {
  if (actor.agentRef) return agentDisplayName(workspaceId, agentRefProjectId(actor.agentRef))
  if (actor.userId) {
    const u = await db.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } })
    return u?.name || u?.email || 'Someone'
  }
  return 'Shogo'
}

async function recordEvent(item: { id: string; workspaceId: string }, type: string, actor: BoardActor, data?: Record<string, unknown>) {
  await db.workItemEvent.create({
    data: {
      workItemId: item.id,
      workspaceId: item.workspaceId,
      type,
      actorUserId: actor.agentRef ? null : actor.userId ?? null,
      actorAgentRef: actor.agentRef ?? null,
      sessionId: actor.sessionId ?? null,
      eventData: data ?? undefined,
    },
  })
  const line = cardEventLine(type, data)
  if (line) {
    const { emitTaskEvent } = await import('./background-tasks.service')
    await emitTaskEvent('work_item', item.id, { line })
  }
}

/** One line per card event, for agents waiting on the card (`until` matches against these). */
function cardEventLine(type: string, data?: Record<string, any>): string | null {
  switch (type) {
    case 'moved': {
      const to = data?.to
      return to ? `moved to ${to.column}${to.category ? ` (${to.category})` : ''}` : 'moved'
    }
    case 'assigned':
      return `assigned to ${data?.label ?? 'someone'}`
    case 'updated':
      return `updated ${(data?.changed ?? []).join(', ')}`.trim()
    case 'commented':
      return `comment: ${String(data?.text ?? '').slice(0, 500)}`
    case 'agent_stopped':
      return `agent stopped with the card still in ${data?.column ?? 'its column'}${data?.reason ? ` (${data.reason})` : ''}`
    case 'agent_failed':
      return 'agent failed on the card'
    case 'archived':
    case 'restored':
    case 'created':
      return type
    default:
      return null
  }
}

/** An agent's tool call on a card links the session that made it. */
async function linkActorSession(item: { id: string; workspaceId: string }, actor: BoardActor) {
  if (!actor.agentRef || !actor.sessionId) return
  await upsertLink(item, { kind: 'chat_session', refId: actor.sessionId, reason: 'tool_call' }, actor)
}

// ─── Boards ──────────────────────────────────────────────────────────────────

export interface ColumnInput {
  name: string
  category?: string
  wipLimit?: number | null
  agentRef?: string | null
  slaHours?: number | null
}

export interface BoardInput {
  name: string
  conversationId?: string | null
  itemType?: string
  description?: string | null
  columns?: ColumnInput[]
  fieldsSchema?: unknown
  postToChannel?: string
  requiresHumanReview?: boolean
  defaultAssigneeAgentRef?: string | null
  keyPrefix?: string
  slug?: string
  position?: number
  managedBy?: string
  systemManagedBy?: string | null
  templateId?: string | null
}

function columnData(input: ColumnInput, position: number) {
  const name = str(input.name, 60)
  if (!name) throw bad('invalid_column', 'Every column needs a name')
  const agentRef = normalizeAgentRef(input.agentRef)
  return {
    name,
    position,
    category: oneOf(COLUMN_CATEGORIES, input.category) ?? 'active',
    wipLimit: Number.isInteger(input.wipLimit) && (input.wipLimit as number) > 0 ? input.wipLimit : null,
    agentRef: agentRef ?? null,
    slaHours: typeof input.slaHours === 'number' && input.slaHours > 0 ? input.slaHours : null,
  }
}

async function assertChannel(workspaceId: string, conversationId: string) {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId }, select: { workspaceId: true, kind: true } })
  if (!conversation || conversation.workspaceId !== workspaceId) throw notFound('Channel')
  if (conversation.kind !== 'public' && conversation.kind !== 'private') {
    throw bad('invalid_channel', 'Boards live in public or private channels')
  }
}

export async function createBoard(workspaceId: string, input: BoardInput, actor: BoardActor) {
  const name = str(input.name, 80)
  if (!name) throw bad('invalid_name', 'A board needs a name')
  const conversationId = input.conversationId ?? null
  if (conversationId) await assertChannel(workspaceId, conversationId)
  const itemType: ItemType = oneOf(ITEM_TYPES, input.itemType) ?? 'task'
  const presets = input.columns?.length ? input.columns : DEFAULT_COLUMNS[itemType]
  const columns = presets.slice(0, 20).map((c, i) => columnData(c, i))
  const names = new Set<string>()
  for (const c of columns) {
    const k = c.name.toLowerCase()
    if (names.has(k)) throw bad('duplicate_column', `Two columns are named "${c.name}"`)
    names.add(k)
  }
  const position = Number.isInteger(input.position)
    ? (input.position as number)
    : await db.board.count({ where: { workspaceId, conversationId, archivedAt: null } })
  const defaultAgent = normalizeAgentRef(input.defaultAssigneeAgentRef)
  const board = await db.board.create({
    data: {
      workspaceId,
      conversationId,
      name,
      slug: await uniqueSlug(workspaceId, input.slug || name),
      keyPrefix: await uniquePrefix(workspaceId, normalizeKeyPrefix(input.keyPrefix) ?? keyPrefixFor(name)),
      position,
      itemType,
      description: str(input.description, 2000) ?? null,
      fieldsSchema: normalizeFieldsSchema(input.fieldsSchema) ?? [],
      postToChannel: oneOf(POST_TO_CHANNEL, input.postToChannel) ?? 'all',
      requiresHumanReview: input.requiresHumanReview === true,
      defaultAssigneeAgentRef: defaultAgent ?? null,
      managedBy: input.managedBy === 'manifest' ? 'manifest' : 'user',
      systemManagedBy: input.systemManagedBy ?? null,
      templateId: str(input.templateId, 100) ?? null,
      createdById: actor.agentRef ? null : actor.userId ?? null,
      columns: { create: columns },
    },
    include: BOARD_INCLUDE,
  })
  await publishBoard(board, { action: 'board.created' })
  return serializeBoard(board)
}

export interface BoardPatch {
  name?: string
  description?: string | null
  itemType?: string
  fieldsSchema?: unknown
  postToChannel?: string
  requiresHumanReview?: boolean
  defaultAssigneeAgentRef?: string | null
  keyPrefix?: string
  conversationId?: string | null
  position?: number
  systemManagedBy?: string | null
  managedBy?: string
}

export async function updateBoard(board: any, patch: BoardPatch) {
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = str(patch.name, 80)
    if (!name) throw bad('invalid_name', 'A board needs a name')
    data.name = name
  }
  if (patch.description !== undefined) data.description = str(patch.description, 2000) ?? null
  if (patch.itemType !== undefined) data.itemType = oneOf(ITEM_TYPES, patch.itemType) ?? board.itemType
  if (patch.fieldsSchema !== undefined) data.fieldsSchema = normalizeFieldsSchema(patch.fieldsSchema) ?? []
  if (patch.postToChannel !== undefined) data.postToChannel = oneOf(POST_TO_CHANNEL, patch.postToChannel) ?? board.postToChannel
  if (patch.requiresHumanReview !== undefined) data.requiresHumanReview = patch.requiresHumanReview === true
  if (patch.defaultAssigneeAgentRef !== undefined) data.defaultAssigneeAgentRef = normalizeAgentRef(patch.defaultAssigneeAgentRef) ?? null
  if (patch.keyPrefix !== undefined) {
    const prefix = normalizeKeyPrefix(patch.keyPrefix)
    if (!prefix) throw bad('invalid_prefix', 'A key prefix is 1–6 letters or digits, starting with a letter')
    // Existing cards keep their keys; new cards use the new prefix.
    data.keyPrefix = await uniquePrefix(board.workspaceId, prefix, board.id)
  }
  if (patch.conversationId !== undefined) {
    if (patch.conversationId) await assertChannel(board.workspaceId, patch.conversationId)
    data.conversationId = patch.conversationId || null
  }
  if (Number.isInteger(patch.position)) data.position = patch.position
  if (patch.systemManagedBy !== undefined) data.systemManagedBy = patch.systemManagedBy
  if (patch.managedBy !== undefined) data.managedBy = patch.managedBy === 'manifest' ? 'manifest' : 'user'
  const updated = await db.board.update({ where: { id: board.id }, data, include: BOARD_INCLUDE })
  await publishBoard(updated, { action: 'board.updated' })
  if (board.conversationId && board.conversationId !== updated.conversationId) await publishBoard(board, { action: 'board.moved' })
  return serializeBoard(updated)
}

export async function archiveBoard(board: any, archived: boolean) {
  const updated = await db.board.update({
    where: { id: board.id },
    data: { archivedAt: archived ? new Date() : null },
    include: BOARD_INCLUDE,
  })
  await publishBoard(updated, { action: archived ? 'board.archived' : 'board.restored' })
  return serializeBoard(updated)
}

/** Tab order for the boards of one channel (or the workspace-level boards). */
export async function reorderBoards(workspaceId: string, conversationId: string | null, boardIds: string[]) {
  const boards = await db.board.findMany({ where: { workspaceId, conversationId, archivedAt: null }, select: { id: true } })
  const known = new Set(boards.map((b: any) => b.id))
  const ordered = boardIds.filter((id) => known.has(id))
  const rest = boards.map((b: any) => b.id).filter((id: string) => !ordered.includes(id))
  const all = [...ordered, ...rest]
  await db.$transaction(all.map((id, position) => db.board.update({ where: { id }, data: { position } })))
  publishConversationEvent(workspaceId, { type: 'board.changed', conversationId: conversationId ?? undefined, action: 'boards.reordered' }, null)
  return all
}

export async function listBoards(workspaceId: string, viewer: BoardViewer, opts: { conversationId?: string | null; includeArchived?: boolean } = {}) {
  const rows = await db.board.findMany({
    where: {
      workspaceId,
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
      ...(opts.includeArchived ? {} : { archivedAt: null }),
    },
    include: BOARD_INCLUDE,
    orderBy: [{ conversationId: 'asc' }, { position: 'asc' }],
  })
  const visible: any[] = []
  const seen = new Map<string | null, boolean>()
  for (const b of rows) {
    const key = b.conversationId ?? null
    if (!seen.has(key)) seen.set(key, await canViewBoard(b, viewer))
    if (seen.get(key)) visible.push(b)
  }
  const counts = visible.length
    ? await db.workItem.groupBy({ by: ['boardId'], where: { boardId: { in: visible.map((b) => b.id) }, archivedAt: null }, _count: { _all: true } })
    : []
  const countBy = new Map<string, number>(counts.map((c: any) => [c.boardId, c._count._all]))
  const channels = await db.conversation.findMany({
    where: { id: { in: visible.map((b) => b.conversationId).filter(Boolean) } },
    select: { id: true, name: true },
  })
  const channelName = new Map<string, string>(channels.map((c: any) => [c.id, c.name]))
  return visible.map((b) => ({ ...serializeBoard(b), itemCount: countBy.get(b.id) ?? 0, channelName: b.conversationId ? channelName.get(b.conversationId) ?? null : null }))
}

// ─── Columns ─────────────────────────────────────────────────────────────────

async function renumberColumns(boardId: string, orderedIds: string[]) {
  await db.$transaction(orderedIds.map((id, position) => db.boardColumn.update({ where: { id }, data: { position } })))
}

export async function createColumn(board: any, input: ColumnInput & { position?: number; after?: string; before?: string }) {
  const columns = (board.columns ?? []).slice().sort((a: any, b: any) => a.position - b.position)
  if (columns.length >= 20) throw bad('too_many_columns', 'A board can have up to 20 columns')
  if (columns.some((c: any) => c.name.toLowerCase() === String(input.name ?? '').trim().toLowerCase())) {
    throw new ConversationError(409, 'duplicate_column', `This board already has a "${input.name}" column`)
  }
  let index = columns.length
  if (input.after) {
    const anchor = resolveColumnIn(board, input.after)
    if (!anchor) throw notFound(`Column "${input.after}"`)
    index = columns.findIndex((c: any) => c.id === anchor.id) + 1
  } else if (input.before) {
    const anchor = resolveColumnIn(board, input.before)
    if (!anchor) throw notFound(`Column "${input.before}"`)
    index = columns.findIndex((c: any) => c.id === anchor.id)
  } else if (Number.isInteger(input.position)) {
    index = Math.max(0, Math.min(input.position as number, columns.length))
  }
  const created = await db.boardColumn.create({ data: { boardId: board.id, ...columnData(input, index) } })
  const order = columns.map((c: any) => c.id)
  order.splice(index, 0, created.id)
  await renumberColumns(board.id, order)
  const fresh = await db.board.findUnique({ where: { id: board.id }, include: BOARD_INCLUDE })
  await publishBoard(fresh, { action: 'column.created' })
  return { column: serializeColumn({ ...created, position: index }), board: serializeBoard(fresh) }
}

export async function updateColumn(board: any, columnRef: string, patch: Partial<ColumnInput> & { position?: number; after?: string }) {
  const column = resolveColumnIn(board, columnRef)
  if (!column) throw notFound(`Column "${columnRef}"`)
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = str(patch.name, 60)
    if (!name) throw bad('invalid_column', 'A column needs a name')
    if (board.columns.some((c: any) => c.id !== column.id && c.name.toLowerCase() === name.toLowerCase())) {
      throw new ConversationError(409, 'duplicate_column', `This board already has a "${name}" column`)
    }
    data.name = name
  }
  if (patch.category !== undefined) data.category = oneOf(COLUMN_CATEGORIES, patch.category) ?? column.category
  if (patch.wipLimit !== undefined) data.wipLimit = Number.isInteger(patch.wipLimit) && (patch.wipLimit as number) > 0 ? patch.wipLimit : null
  if (patch.agentRef !== undefined) data.agentRef = normalizeAgentRef(patch.agentRef) ?? null
  if (patch.slaHours !== undefined) data.slaHours = typeof patch.slaHours === 'number' && patch.slaHours > 0 ? patch.slaHours : null
  if (Object.keys(data).length) await db.boardColumn.update({ where: { id: column.id }, data })
  if (Number.isInteger(patch.position) || patch.after) {
    const order = board.columns.slice().sort((a: any, b: any) => a.position - b.position).map((c: any) => c.id).filter((id: string) => id !== column.id)
    let index = Number.isInteger(patch.position) ? Math.max(0, Math.min(patch.position as number, order.length)) : order.length
    if (patch.after) {
      const anchor = resolveColumnIn(board, patch.after)
      if (!anchor) throw notFound(`Column "${patch.after}"`)
      index = order.indexOf(anchor.id) + 1
    }
    order.splice(index, 0, column.id)
    await renumberColumns(board.id, order)
  }
  const fresh = await db.board.findUnique({ where: { id: board.id }, include: BOARD_INCLUDE })
  await publishBoard(fresh, { action: 'column.updated' })
  return { column: serializeColumn(fresh.columns.find((c: any) => c.id === column.id)), board: serializeBoard(fresh) }
}

/** Refuses while cards remain, unless they're moved to `moveTo` first. */
export async function deleteColumn(board: any, columnRef: string, moveTo: string | undefined, actor: BoardActor) {
  const column = resolveColumnIn(board, columnRef)
  if (!column) throw notFound(`Column "${columnRef}"`)
  if (board.columns.length <= 1) throw bad('last_column', 'A board needs at least one column')
  const items = await db.workItem.findMany({ where: { columnId: column.id }, select: { id: true, workspaceId: true } })
  if (items.length) {
    const target = moveTo ? resolveColumnIn(board, moveTo) : undefined
    if (!target || target.id === column.id) {
      throw new ConversationError(409, 'column_not_empty', `"${column.name}" still has ${items.length} card(s). Pass move_to with another column to move them first.`)
    }
    const now = new Date()
    await db.workItem.updateMany({
      where: { columnId: column.id },
      data: { columnId: target.id, columnEnteredAt: now, lastActivityAt: now, ...(isClosed(target.category) ? { completedAt: now } : { completedAt: null }) },
    })
    for (const item of items) {
      await recordEvent(item, 'moved', actor, { from: { columnId: column.id, column: column.name }, to: { columnId: target.id, column: target.name }, reason: 'column_deleted' })
    }
  }
  await db.boardColumn.delete({ where: { id: column.id } })
  const fresh = await db.board.findUnique({ where: { id: board.id }, include: BOARD_INCLUDE })
  await renumberColumns(board.id, fresh.columns.sort((a: any, b: any) => a.position - b.position).map((c: any) => c.id))
  const final = await db.board.findUnique({ where: { id: board.id }, include: BOARD_INCLUDE })
  await publishBoard(final, { action: 'column.deleted' })
  return { moved: items.length, board: serializeBoard(final) }
}

// ─── Card threads ────────────────────────────────────────────────────────────

async function originUserFor(item: any, board: any, actor: BoardActor): Promise<string | null> {
  return actor.userId ?? board.createdById ?? item.createdById ?? (await workspaceOwnerId(item.workspaceId))
}

async function cardFor(item: any, column: any): Promise<StatusCard> {
  const assignee = await assigneeLabel(item.workspaceId, item)
  const due = item.dueAt ? ` · due ${new Date(item.dueAt).toISOString().slice(0, 10)}` : ''
  return {
    title: `${item.key} · ${item.title}`.slice(0, 200),
    status: cardStatusFor(column.category),
    summary: `${column.name} · ${assignee}${item.priority !== 'none' ? ` · ${item.priority}` : ''}${due}`,
    links: [{ label: 'Open card', url: itemUrl(item) }],
  }
}

function cardBlocks(item: any, card: StatusCard) {
  return { ...blocksForKind({ kind: 'status', card }), workItem: { id: item.id, key: item.key, boardId: item.boardId } }
}

function rootText(item: any, card: StatusCard): string {
  const description = item.description ? `\n\n${String(item.description).slice(0, 600)}` : ''
  return `**${card.title}**\n${card.summary ?? ''}${description}`
}

/**
 * The card's thread in its board's channel, created on first need. Boards with
 * no channel have no threads; their history is events and links only.
 */
export async function ensureThread(itemId: string, actor: BoardActor = {}): Promise<{ conversation: any; rootId: string } | null> {
  const item = await db.workItem.findUnique({ where: { id: itemId }, include: { column: true, board: true } })
  if (!item) return null
  if (item.threadRootMessageId && item.conversationId) {
    const conversation = await db.conversation.findUnique({ where: { id: item.conversationId } })
    if (conversation) return { conversation, rootId: item.threadRootMessageId }
  }
  if (!item.board.conversationId) return null
  const conversation = await db.conversation.findUnique({ where: { id: item.board.conversationId } })
  if (!conversation || conversation.archivedAt) return null
  const originUserId = await originUserFor(item, item.board, actor)
  const card = await cardFor({ ...item, conversationId: conversation.id }, item.column)
  const result = await postMessage({
    conversationId: conversation.id,
    authorType: 'system',
    text: rootText(item, card),
    blocks: cardBlocks(item, card),
    clientMsgId: `card:${item.id}`,
    agentChain: originUserId
      ? { rootMessageId: '', originUserId, depth: 0, hops: [], turns: 0, runId: item.id }
      : null,
  })
  await db.workItem.update({ where: { id: item.id }, data: { conversationId: conversation.id, threadRootMessageId: result.row.id } })
  await upsertLink(item, { kind: 'thread', refId: result.row.id, conversationId: conversation.id, reason: 'origin', snippet: item.title }, actor)
  if (!result.duplicate) void afterMessagePosted(result, { actorUserId: null, origin: 'system' })
  return { conversation, rootId: result.row.id }
}

async function refreshCardMessage(itemId: string) {
  const item = await db.workItem.findUnique({ where: { id: itemId }, include: { column: true } })
  if (!item?.threadRootMessageId) return
  const card = await cardFor(item, item.column)
  await updateMessageInternal(item.threadRootMessageId, { text: rootText(item, card), blocks: cardBlocks(item, card) }).catch((err: Error) => {
    console.warn('[Boards] card message refresh failed:', err.message)
  })
}

/** A compact line in the card thread, per the board's `postToChannel` setting. */
async function postActivity(item: any, board: any, text: string, opts: { done?: boolean } = {}) {
  if (board.postToChannel === 'none') return
  if (board.postToChannel === 'done_only' && !opts.done) return
  const thread = await ensureThread(item.id)
  if (!thread) return
  const result = await postMessage({
    conversationId: thread.conversation.id,
    authorType: 'system',
    threadRootId: thread.rootId,
    alsoSentToChannel: !!opts.done,
    text,
  })
  void afterMessagePosted(result, { actorUserId: null, origin: 'system' })
}

/**
 * Hand the card to an agent: tag it in the card thread and run it there, the
 * same path as an @mention. Capped per card per hour so two agents moving a
 * card back and forth can't loop.
 */
export async function wakeAgent(itemId: string, agentRef: string, actor: BoardActor, reason: string): Promise<{ woken: boolean; reason?: string }> {
  const item = await db.workItem.findUnique({ where: { id: itemId }, include: { column: true, board: true } })
  if (!item) return { woken: false, reason: 'not_found' }
  if (actor.agentRef && actor.agentRef === agentRef) return { woken: false, reason: 'self' }
  const recent = await db.workItemEvent.count({
    where: { workItemId: item.id, type: 'agent_woken', createdAt: { gt: new Date(Date.now() - 3_600_000) } },
  })
  if (recent >= MAX_AGENT_WAKES_PER_HOUR) {
    await recordEvent(item, 'agent_wake_skipped', actor, { agentRef, reason: 'rate_limited' })
    return { woken: false, reason: 'rate_limited' }
  }
  const thread = await ensureThread(item.id, actor)
  if (!thread) {
    await recordEvent(item, 'agent_wake_skipped', actor, { agentRef, reason: 'no_channel' })
    return { woken: false, reason: 'no_channel' }
  }
  const projectId = agentRefProjectId(agentRef)
  const target = { projectId }
  const originUserId = await originUserFor(item, item.board, actor)
  if (!originUserId) return { woken: false, reason: 'no_origin_user' }
  const summary = item.historySummary ? `\n\nWhere it stands: ${String(item.historySummary).slice(0, 800)}` : ''
  const text = `${agentMentionToken(projectId)} ${item.key} is yours (${reason}): **${item.title}** — ${item.column.name}.${summary}\n\nRead it with work_item_get("${item.key}"), do the work here in this thread, then move it with work_item_move.`
  const posted = await postMessage({
    conversationId: thread.conversation.id,
    authorType: 'system',
    threadRootId: thread.rootId,
    text,
  })
  const { setThreadOwner } = await import('./conversation-agent-chain')
  await setThreadOwner(thread.rootId, target, item.id)
  await recordEvent(item, 'agent_woken', actor, { agentRef, reason, messageId: posted.row.id })
  const { runAgentReply } = await import('./conversation-agent-dispatcher')
  void runAgentReply({ conversation: thread.conversation, trigger: posted.row, target, userId: originUserId })
    .catch((err: Error) => console.error('[Boards] agent wake failed:', err.message))
  return { woken: true }
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export interface ItemInput {
  title: string
  description?: string | null
  column?: string
  fields?: Record<string, unknown>
  priority?: string
  assigneeUserId?: string | null
  assigneeAgentRef?: string | null
  dueAt?: string | Date | null
  goalId?: string | null
  projectId?: string | null
  source?: string
  externalRef?: string | null
  eventSubscriptionId?: string | null
  fingerprint?: string | null
  /** Message the card was made from; linked and quoted in the thread. */
  originMessageId?: string | null
}

async function nextPosition(columnId: string): Promise<number> {
  const last = await db.workItem.findFirst({ where: { columnId }, orderBy: { position: 'desc' }, select: { position: true } })
  return (last?.position ?? 0) + 1
}

async function assertAssignableUser(workspaceId: string, userId: string) {
  if (!(await getWorkspaceRole(workspaceId, userId))) throw bad('invalid_assignee', 'The assignee is not a member of this workspace')
}

async function assertAssignableAgent(workspaceId: string, ref: string) {
  const projectId = agentRefProjectId(ref)
  if (!projectId) return
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
  if (project?.workspaceId !== workspaceId) throw bad('invalid_assignee', 'That agent is not in this workspace')
}

export async function createWorkItem(board: any, input: ItemInput, actor: BoardActor) {
  if (board.archivedAt) throw bad('board_archived', 'This board is archived')
  const title = str(input.title, 300)
  if (!title) throw bad('invalid_title', 'A card needs a title')
  const column = input.column ? resolveColumnIn(board, input.column) : defaultColumn(board)
  if (!column) throw notFound(`Column "${input.column}"`)
  const assigneeAgentRef = normalizeAgentRef(input.assigneeAgentRef) ?? (input.assigneeUserId ? null : board.defaultAssigneeAgentRef ?? null)
  if (input.assigneeUserId) await assertAssignableUser(board.workspaceId, input.assigneeUserId)
  if (assigneeAgentRef) await assertAssignableAgent(board.workspaceId, assigneeAgentRef)
  const counter = await db.board.update({ where: { id: board.id }, data: { itemCounter: { increment: 1 } }, select: { itemCounter: true, keyPrefix: true } })
  const now = new Date()
  const item = await db.workItem.create({
    data: {
      workspaceId: board.workspaceId,
      boardId: board.id,
      columnId: column.id,
      position: await nextPosition(column.id),
      key: `${counter.keyPrefix}-${counter.itemCounter}`,
      number: counter.itemCounter,
      title,
      description: str(input.description, 20_000) ?? null,
      fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
      priority: oneOf(PRIORITIES, input.priority) ?? 'none',
      assigneeUserId: input.assigneeUserId ?? null,
      assigneeAgentRef,
      dueAt: dateOrNull(input.dueAt) ?? null,
      goalId: input.goalId ?? null,
      projectId: input.projectId ?? null,
      source: oneOf(ITEM_SOURCES, input.source) ?? (actor.agentRef ? 'agent' : 'manual'),
      externalRef: str(input.externalRef, 500) ?? null,
      eventSubscriptionId: input.eventSubscriptionId ?? null,
      fingerprint: str(input.fingerprint, 300) ?? null,
      createdById: actor.agentRef ? null : actor.userId ?? null,
      createdByAgentRef: actor.agentRef ?? null,
      columnEnteredAt: now,
      lastActivityAt: now,
      completedAt: isClosed(column.category) ? now : null,
    },
    include: { column: true, board: true },
  })
  await recordEvent(item, 'created', actor, { column: column.name, source: item.source })
  await linkActorSession(item, actor)
  if (input.originMessageId) {
    const origin = await db.conversationMessage.findUnique({ where: { id: input.originMessageId }, select: { id: true, workspaceId: true, conversationId: true, text: true } })
    if (origin?.workspaceId === board.workspaceId) {
      await upsertLink(item, { kind: 'message', refId: origin.id, conversationId: origin.conversationId, reason: 'origin', snippet: String(origin.text ?? '').slice(0, 280) }, actor)
    }
  }
  if (board.conversationId && board.postToChannel === 'all') await ensureThread(item.id, actor)
  const handoff = assigneeAgentRef ?? column.agentRef
  if (handoff) await wakeAgent(item.id, handoff, actor, assigneeAgentRef ? 'assigned' : `new card in ${column.name}`)
  await publishBoard(board, { action: 'item.created', itemId: item.id })
  const fresh = await db.workItem.findUnique({ where: { id: item.id }, include: { column: true, board: true } })
  await workActivity('work.created', fresh, board, actor, 'created')
  return serializeItem(fresh)
}

export interface ItemPatch {
  title?: string
  description?: string | null
  fields?: Record<string, unknown>
  priority?: string
  assigneeUserId?: string | null
  assigneeAgentRef?: string | null
  dueAt?: string | Date | null
  goalId?: string | null
  projectId?: string | null
  externalRef?: string | null
  historySummary?: string | null
}

export async function updateWorkItem(item: any, patch: ItemPatch, actor: BoardActor) {
  const data: Record<string, unknown> = {}
  const changed: string[] = []
  if (patch.title !== undefined) {
    const title = str(patch.title, 300)
    if (!title) throw bad('invalid_title', 'A card needs a title')
    data.title = title
  }
  if (patch.description !== undefined) data.description = str(patch.description, 20_000) ?? null
  if (patch.fields !== undefined) {
    if (!patch.fields || typeof patch.fields !== 'object') throw bad('invalid_fields', 'fields must be an object')
    const merged: Record<string, unknown> = { ...(item.fields ?? {}) }
    for (const [k, v] of Object.entries(patch.fields)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    data.fields = merged
  }
  if (patch.priority !== undefined) data.priority = oneOf(PRIORITIES, patch.priority) ?? item.priority
  if (patch.dueAt !== undefined) {
    const due = dateOrNull(patch.dueAt)
    if (due === undefined) throw bad('invalid_due', 'due_at must be an ISO date')
    data.dueAt = due
  }
  if (patch.goalId !== undefined) data.goalId = patch.goalId || null
  if (patch.projectId !== undefined) data.projectId = patch.projectId || null
  if (patch.externalRef !== undefined) data.externalRef = str(patch.externalRef, 500) ?? null
  if (patch.historySummary !== undefined) {
    data.historySummary = str(patch.historySummary, 8000) ?? null
    data.historySummaryAt = new Date()
  }
  let newAgent: string | null = null
  if (patch.assigneeUserId !== undefined) {
    if (patch.assigneeUserId) await assertAssignableUser(item.workspaceId, patch.assigneeUserId)
    data.assigneeUserId = patch.assigneeUserId || null
    if (patch.assigneeUserId && patch.assigneeAgentRef === undefined) data.assigneeAgentRef = null
  }
  if (patch.assigneeAgentRef !== undefined) {
    const ref = normalizeAgentRef(patch.assigneeAgentRef)
    if (ref === undefined) throw bad('invalid_assignee', 'assignee_agent must be "workspace" or a project id')
    if (ref) await assertAssignableAgent(item.workspaceId, ref)
    data.assigneeAgentRef = ref
    if (ref && patch.assigneeUserId === undefined) data.assigneeUserId = null
    if (ref && ref !== item.assigneeAgentRef) newAgent = ref
  }
  for (const k of Object.keys(data)) {
    if (k !== 'historySummaryAt' && JSON.stringify(data[k]) !== JSON.stringify(item[k])) changed.push(k)
  }
  if (!changed.length) return serializeItem(item)
  data.lastActivityAt = new Date()
  const updated = await db.workItem.update({ where: { id: item.id }, data, include: { column: true, board: true } })
  const assignment = changed.includes('assigneeUserId') || changed.includes('assigneeAgentRef')
  const rest = changed.filter((k) => k !== 'assigneeUserId' && k !== 'assigneeAgentRef' && k !== 'historySummary')
  if (rest.length) await recordEvent(item, 'updated', actor, { changed: rest })
  if (changed.includes('historySummary')) await recordEvent(item, 'summarized', actor)
  await linkActorSession(item, actor)
  if (assignment) {
    const label = await assigneeLabel(item.workspaceId, updated)
    await recordEvent(item, 'assigned', actor, { assigneeUserId: updated.assigneeUserId, assigneeAgentRef: updated.assigneeAgentRef, label })
    await postActivity(updated, updated.board, `${await actorLabel(item.workspaceId, actor)} assigned ${item.key} to ${label}`)
    if (updated.assigneeUserId && updated.assigneeUserId !== actor.userId) {
      await db.workItemSubscription.upsert({
        where: { workItemId_userId: { workItemId: item.id, userId: updated.assigneeUserId } },
        create: { workItemId: item.id, userId: updated.assigneeUserId },
        update: {},
      }).catch(() => {})
    }
  }
  if (rest.length || assignment) await refreshCardMessage(item.id)
  if (newAgent) await wakeAgent(item.id, newAgent, actor, 'assigned')
  await publishBoard(updated.board, { action: 'item.updated', itemId: item.id })
  return serializeItem(updated)
}

export interface MoveInput {
  column?: string
  board?: string
  /** Card id to place this card after (or before). */
  after?: string
  before?: string
  position?: number
}

async function positionFor(columnId: string, input: MoveInput, itemId: string): Promise<number> {
  const neighbours = await db.workItem.findMany({
    where: { columnId, archivedAt: null, NOT: { id: itemId } },
    orderBy: { position: 'asc' },
    select: { id: true, position: true },
  })
  const anchorId = input.after ?? input.before
  if (anchorId) {
    const i = neighbours.findIndex((n: any) => n.id === anchorId)
    if (i >= 0) {
      if (input.after) {
        const next = neighbours[i + 1]
        return next ? (neighbours[i].position + next.position) / 2 : neighbours[i].position + 1
      }
      const prev = neighbours[i - 1]
      return prev ? (prev.position + neighbours[i].position) / 2 : neighbours[i].position - 1
    }
  }
  if (Number.isInteger(input.position)) {
    const i = Math.max(0, Math.min(input.position as number, neighbours.length))
    if (!neighbours.length) return 1
    if (i === 0) return neighbours[0].position - 1
    if (i >= neighbours.length) return neighbours[neighbours.length - 1].position + 1
    return (neighbours[i - 1].position + neighbours[i].position) / 2
  }
  return (neighbours[neighbours.length - 1]?.position ?? 0) + 1
}

export async function moveWorkItem(item: any, input: MoveInput, actor: BoardActor) {
  const fromBoard = item.board
  const fromColumn = item.column
  const toBoard = input.board ? await resolveBoard(item.workspaceId, input.board) : fromBoard
  if (toBoard.workspaceId !== item.workspaceId) throw notFound('Board')
  if (toBoard.archivedAt) throw bad('board_archived', 'That board is archived')
  const toColumn = input.column ? resolveColumnIn(toBoard, input.column) : toBoard.id === fromBoard.id ? fromColumn : defaultColumn(toBoard)
  if (!toColumn) throw notFound(`Column "${input.column}" on ${toBoard.name}`)
  if (toBoard.requiresHumanReview && actor.agentRef && toColumn.category === 'done' && fromColumn.category !== 'review') {
    throw new ConversationError(403, 'review_required', `${toBoard.name} needs a person to review cards before they are done. Move it to a review column instead.`)
  }
  const sameColumn = toColumn.id === fromColumn.id
  const now = new Date()
  const position = await positionFor(toColumn.id, input, item.id)
  const updated = await db.workItem.update({
    where: { id: item.id },
    data: {
      boardId: toBoard.id,
      columnId: toColumn.id,
      position,
      lastActivityAt: now,
      ...(sameColumn ? {} : { columnEnteredAt: now, completedAt: isClosed(toColumn.category) ? now : null }),
    },
    include: { column: true, board: true },
  })
  if (sameColumn) {
    await publishBoard(toBoard, { action: 'item.reordered', itemId: item.id })
    return { item: serializeItem(updated), warnings: [] as string[] }
  }
  const warnings: string[] = []
  if (toColumn.wipLimit) {
    const count = await db.workItem.count({ where: { columnId: toColumn.id, archivedAt: null } })
    if (count > toColumn.wipLimit) warnings.push(`${toColumn.name} is over its WIP limit (${count}/${toColumn.wipLimit})`)
  }
  await recordEvent(item, 'moved', actor, {
    from: { boardId: fromBoard.id, board: fromBoard.name, columnId: fromColumn.id, column: fromColumn.name, category: fromColumn.category },
    to: { boardId: toBoard.id, board: toBoard.name, columnId: toColumn.id, column: toColumn.name, category: toColumn.category },
  })
  if (isClosed(fromColumn.category) && !isClosed(toColumn.category)) {
    await recordEvent(item, 'regressed', actor, { from: fromColumn.name })
    await workActivity('work.regressed', updated, toBoard, actor, `regressed:${now.getTime()}`)
  } else if (toColumn.category === 'done') {
    await workActivity('work.done', updated, toBoard, actor, `done:${now.getTime()}`)
  }
  await linkActorSession(item, actor)

  if (toBoard.conversationId && toBoard.conversationId !== fromBoard.conversationId) {
    await postEscalationLink(updated, fromBoard, toBoard, actor)
  }
  await refreshCardMessage(item.id)
  const who = await actorLabel(item.workspaceId, actor)
  const where = toBoard.id === fromBoard.id ? toColumn.name : `${toBoard.name} › ${toColumn.name}`
  await postActivity(updated, fromBoard, `${who} moved ${item.key} to ${where}`, { done: isClosed(toColumn.category) })
  if (toColumn.agentRef) await wakeAgent(item.id, toColumn.agentRef, actor, `moved to ${toColumn.name}`)
  await publishBoard(fromBoard, { action: 'item.moved', itemId: item.id })
  if (toBoard.id !== fromBoard.id) await publishBoard(toBoard, { action: 'item.moved', itemId: item.id })
  return { item: serializeItem(updated), warnings }
}

/** The card stays in its home thread; the destination channel gets a pointer to it. */
async function postEscalationLink(item: any, fromBoard: any, toBoard: any, actor: BoardActor) {
  const conversation = await db.conversation.findUnique({ where: { id: toBoard.conversationId } })
  if (!conversation || conversation.archivedAt) return
  const from = fromBoard.conversationId ? await db.conversation.findUnique({ where: { id: fromBoard.conversationId }, select: { name: true } }) : null
  const result = await postMessage({
    conversationId: conversation.id,
    authorType: 'system',
    text: `**${item.key} · ${item.title}** moved to ${toBoard.name}${from?.name ? ` from #${from.name}` : ''}. [Open card](${itemUrl(item)})`,
    blocks: { workItem: { id: item.id, key: item.key, boardId: toBoard.id } },
  })
  await upsertLink(item, { kind: 'message', refId: result.row.id, conversationId: conversation.id, reason: 'escalation', snippet: `Moved to ${toBoard.name}` }, actor)
  void afterMessagePosted(result, { actorUserId: null, origin: 'system' })
}

/** A comment is a reply in the card thread; boards with no channel keep it as an event. */
export async function commentWorkItem(item: any, text: string, actor: BoardActor, opts: { projectId?: string | null } = {}) {
  const body = String(text ?? '').trim()
  if (!body) throw bad('empty', 'A comment needs text')
  const thread = await ensureThread(item.id, actor)
  await db.workItem.update({ where: { id: item.id }, data: { lastActivityAt: new Date() } })
  await linkActorSession(item, actor)
  if (!thread) {
    await recordEvent(item, 'commented', actor, { text: body.slice(0, 8000) })
    await publishBoard(item.board, { action: 'item.commented', itemId: item.id })
    return { messageId: null, threadRootId: null }
  }
  let result
  if (actor.agentRef) {
    const projectId = opts.projectId ?? agentRefProjectId(actor.agentRef)
    const { postAgentMessage } = await import('./chat-providers/outbound')
    const { chainForAgentPost, rootChain } = await import('./conversation-agent-chain')
    const chain = await chainForAgentPost({ workspaceId: item.workspaceId, agent: { projectId }, sessionId: actor.sessionId ?? null, runId: item.id })
      ?? (await rootChain(thread.rootId))
    result = await postAgentMessage({
      conversationId: thread.conversation.id,
      text: body,
      agent: { projectId, name: await agentDisplayName(item.workspaceId, projectId) },
      threadRootId: thread.rootId,
      agentChain: chain,
    })
    void afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
  } else {
    result = await postMessage({
      conversationId: thread.conversation.id,
      authorType: 'user',
      authorUserId: actor.userId ?? null,
      threadRootId: thread.rootId,
      text: body,
    })
    void afterMessagePosted(result, { actorUserId: actor.userId ?? null, origin: 'app' })
  }
  return { messageId: result.row.id, threadRootId: thread.rootId }
}

export async function archiveWorkItem(item: any, archived: boolean, actor: BoardActor) {
  const updated = await db.workItem.update({
    where: { id: item.id },
    data: { archivedAt: archived ? new Date() : null, lastActivityAt: new Date() },
    include: { column: true, board: true },
  })
  await recordEvent(item, archived ? 'archived' : 'restored', actor)
  await publishBoard(item.board, { action: archived ? 'item.archived' : 'item.restored', itemId: item.id })
  return serializeItem(updated)
}

export interface BulkPatch extends ItemPatch {
  column?: string
  archived?: boolean
}

/** Same change to many cards (Inbox A/P/S keys, agent sweeps). Each card is checked and recorded on its own. */
export async function bulkUpdateWorkItems(workspaceId: string, ids: string[], patch: BulkPatch, actor: BoardActor, authorize: (item: any) => Promise<void>) {
  const unique = [...new Set(ids)].slice(0, MAX_BULK)
  const results: Array<{ id: string; ok: boolean; key?: string; error?: string }> = []
  for (const id of unique) {
    try {
      let item = await getItemRow(workspaceId, id)
      await authorize(item)
      const { column, archived, ...rest } = patch
      if (Object.keys(rest).length) {
        await updateWorkItem(item, rest, actor)
        item = await getItemRow(workspaceId, item.id)
      }
      if (column) {
        await moveWorkItem(item, { column }, actor)
        item = await getItemRow(workspaceId, item.id)
      }
      if (archived !== undefined) await archiveWorkItem(item, archived, actor)
      results.push({ id: item.id, key: item.key, ok: true })
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { updated: results.filter((r) => r.ok).length, results }
}

// ─── Links ───────────────────────────────────────────────────────────────────

export interface LinkInput {
  kind: string
  refId: string
  conversationId?: string | null
  reason?: string
  snippet?: string | null
  url?: string | null
}

export async function upsertLink(item: { id: string; workspaceId: string }, input: LinkInput, actor: BoardActor) {
  const kind = oneOf(LINK_KINDS, input.kind)
  if (!kind) throw bad('invalid_link', `kind must be one of ${LINK_KINDS.join(', ')}`)
  const refId = str(input.refId, 300)
  if (!refId) throw bad('invalid_link', 'A link needs a ref id')
  const reason = oneOf(LINK_REASONS, input.reason) ?? 'manual'
  const existing = await db.workItemLink.findFirst({ where: { workItemId: item.id, kind, refId } })
  if (existing) return existing
  try {
    const link = await db.workItemLink.create({
      data: {
        workItemId: item.id,
        workspaceId: item.workspaceId,
        kind,
        refId,
        conversationId: input.conversationId ?? null,
        reason,
        addedByUserId: actor.agentRef ? null : actor.userId ?? null,
        addedByAgentRef: actor.agentRef ?? null,
        snippet: str(input.snippet, 500) ?? null,
        url: str(input.url, 1000) ?? null,
      },
    })
    if (reason !== 'origin' && reason !== 'tool_call' && kind !== 'thread') {
      await recordEvent(item, 'linked', actor, { kind, refId, reason })
    }
    return link
  } catch {
    return db.workItemLink.findFirst({ where: { workItemId: item.id, kind, refId } })
  }
}

/** Manual "link to card" from a message, or an agent's work_item_link. */
export async function linkWorkItem(item: any, input: LinkInput, actor: BoardActor) {
  let { conversationId, snippet } = input
  if (input.kind === 'message' || input.kind === 'thread') {
    const msg = await db.conversationMessage.findUnique({ where: { id: input.refId }, select: { workspaceId: true, conversationId: true, text: true } })
    if (!msg || msg.workspaceId !== item.workspaceId) throw notFound('Message')
    conversationId = msg.conversationId
    snippet ??= String(msg.text ?? '').slice(0, 280)
  }
  if (input.kind === 'chat_session') {
    const session = await db.chatSession.findUnique({ where: { id: input.refId }, select: { id: true } }).catch(() => null)
    if (!session) throw notFound('Chat session')
  }
  const link = await upsertLink(item, { ...input, conversationId, snippet, reason: input.reason ?? 'manual' }, actor)
  await db.workItem.update({ where: { id: item.id }, data: { lastActivityAt: new Date() } })
  await publishBoard(item.board, { action: 'item.linked', itemId: item.id })
  return link
}

async function redactLinks(links: any[], viewer: BoardViewer) {
  const visible = new Map<string, boolean>()
  const out: any[] = []
  for (const l of links) {
    let ok = true
    if (l.conversationId) {
      if (!visible.has(l.conversationId)) {
        let can = false
        if (viewer.kind === 'user') {
          try {
            await loadAccess(l.conversationId, viewer.userId)
            can = true
          } catch {
            can = false
          }
        } else {
          can = await agentCanSeeConversation(l.conversationId, viewer.projectId)
        }
        visible.set(l.conversationId, can)
      }
      ok = visible.get(l.conversationId)!
    }
    out.push(ok
      ? { id: l.id, kind: l.kind, refId: l.refId, conversationId: l.conversationId, reason: l.reason, snippet: l.snippet, url: l.url, addedByUserId: l.addedByUserId, addedByAgentRef: l.addedByAgentRef, createdAt: l.createdAt }
      : { id: l.id, kind: l.kind, reason: l.reason, private: true, snippet: null, refId: null, conversationId: null, createdAt: l.createdAt })
  }
  return out
}

// ─── Reading ─────────────────────────────────────────────────────────────────

async function threadMessages(item: any, limit: number, before?: Date) {
  if (!item.threadRootMessageId) return []
  const rows = await db.conversationMessage.findMany({
    where: {
      OR: [{ id: item.threadRootMessageId }, { threadRootId: item.threadRootMessageId }],
      deletedAt: null,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    include: { authorUser: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.reverse().map((r: any) => ({
    id: r.id,
    author: r.authorType === 'user' ? (r.authorUser?.name || r.authorUser?.email || 'Someone') : r.authorType === 'agent' ? (r.authorAgentRef?.name ?? 'Agent') : 'System',
    authorType: r.authorType,
    text: String(r.text ?? '').slice(0, 2000),
    agentSessionId: r.agentSessionId ?? null,
    agentStatus: r.agentStatus ?? null,
    createdAt: r.createdAt,
  }))
}

/** A card with what an agent or person needs to pick it up: summary, recent thread, links, past agent runs. */
export async function getWorkItemDetail(item: any, viewer: BoardViewer) {
  const [messages, links, events, subscription] = await Promise.all([
    threadMessages(item, 15),
    db.workItemLink.findMany({ where: { workItemId: item.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.workItemEvent.findMany({ where: { workItemId: item.id }, orderBy: { createdAt: 'desc' }, take: 25 }),
    viewer.kind === 'user' ? db.workItemSubscription.findFirst({ where: { workItemId: item.id, userId: viewer.userId } }) : null,
  ])
  const visibleLinks = await redactLinks(links, viewer)
  const sessionIds = links.filter((l: any) => l.kind === 'chat_session').map((l: any) => l.refId)
  const sessions = sessionIds.length
    ? await db.chatSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, name: true, inferredName: true, contextType: true, contextId: true, createdAt: true, updatedAt: true } }).catch(() => [])
    : []
  return {
    item: serializeItem(item),
    board: {
      id: item.board.id,
      name: item.board.name,
      slug: item.board.slug,
      itemType: item.board.itemType,
      conversationId: item.board.conversationId ?? null,
      fieldsSchema: item.board.fieldsSchema ?? [],
      columns: (item.board.columns ?? []).slice().sort((a: any, b: any) => a.position - b.position).map(serializeColumn),
    },
    column: serializeColumn(item.column),
    url: itemUrl(item),
    following: !!subscription,
    recentMessages: messages,
    links: visibleLinks.filter((l) => l.kind !== 'chat_session'),
    agentRuns: sessions.map((s: any) => ({
      sessionId: s.id,
      name: s.name || s.inferredName || 'Agent run',
      projectId: s.contextType === 'project' ? s.contextId ?? null : null,
      agentRef: links.find((l: any) => l.kind === 'chat_session' && l.refId === s.id)?.addedByAgentRef ?? null,
      startedAt: s.createdAt,
      lastActiveAt: s.updatedAt,
    })),
    events: events.reverse().map(serializeEvent),
  }
}

function serializeEvent(e: any) {
  return { id: e.id, type: e.type, actorUserId: e.actorUserId ?? null, actorAgentRef: e.actorAgentRef ?? null, sessionId: e.sessionId ?? null, data: e.eventData ?? null, createdAt: e.createdAt }
}

export type HistoryFilter = 'all' | 'comments' | 'status' | 'agent' | 'links'

/** One timeline: thread messages, card events and linked conversations, newest first. */
export async function getWorkItemHistory(item: any, viewer: BoardViewer, opts: { limit?: number; before?: string; filter?: HistoryFilter } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const before = opts.before ? new Date(opts.before) : undefined
  const filter = opts.filter ?? 'all'
  const when = before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}
  const wantMessages = filter === 'all' || filter === 'comments' || filter === 'agent'
  const wantEvents = filter === 'all' || filter === 'status' || filter === 'agent'
  const wantLinks = filter === 'all' || filter === 'links' || filter === 'agent'
  const [messages, events, links] = await Promise.all([
    wantMessages ? threadMessages(item, limit, before && !Number.isNaN(before.getTime()) ? before : undefined) : [],
    wantEvents ? db.workItemEvent.findMany({ where: { workItemId: item.id, ...when }, orderBy: { createdAt: 'desc' }, take: limit }) : [],
    wantLinks ? db.workItemLink.findMany({ where: { workItemId: item.id, ...when }, orderBy: { createdAt: 'desc' }, take: limit }) : [],
  ])
  const AGENT_EVENTS = new Set(['agent_woken', 'agent_failed', 'agent_wake_skipped', 'summarized'])
  const entries: any[] = []
  for (const m of messages) {
    if (filter === 'agent' && m.authorType !== 'agent') continue
    if (filter === 'comments' && m.authorType === 'system') continue
    entries.push({ type: 'message', at: m.createdAt, message: m })
  }
  for (const e of events) {
    if (filter === 'agent' && !AGENT_EVENTS.has(e.type) && !e.actorAgentRef) continue
    if (filter === 'status' && AGENT_EVENTS.has(e.type)) continue
    entries.push({ type: 'event', at: e.createdAt, event: serializeEvent(e) })
  }
  for (const l of await redactLinks(links, viewer)) {
    if (filter === 'agent' && l.kind !== 'chat_session' && l.kind !== 'agent_task') continue
    if (l.kind === 'thread') continue
    entries.push({ type: 'link', at: l.createdAt, link: l })
  }
  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  const page = entries.slice(0, limit)
  return { entries: page, nextBefore: page.length === limit ? new Date(page[page.length - 1].at).toISOString() : null }
}

export async function getBoardView(board: any, opts: { includeArchived?: boolean; assigneeUserId?: string; assigneeAgentRef?: string; priority?: string; q?: string } = {}) {
  const items = await db.workItem.findMany({
    where: {
      boardId: board.id,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.assigneeUserId ? { assigneeUserId: opts.assigneeUserId } : {}),
      ...(opts.assigneeAgentRef ? { assigneeAgentRef: opts.assigneeAgentRef } : {}),
      ...(oneOf(PRIORITIES, opts.priority) ? { priority: opts.priority } : {}),
      ...(opts.q ? { OR: [{ title: { contains: opts.q } }, { key: { contains: opts.q.toUpperCase() } }] } : {}),
    },
    orderBy: [{ position: 'asc' }],
    take: MAX_ITEMS_PER_BOARD_VIEW,
  })
  return { board: serializeBoard(board), items: items.map(serializeItem), health: healthFor(board, items) }
}

export interface InboxFilter {
  boardId?: string
  conversationId?: string
  assigneeUserId?: string
  assigneeAgentRef?: string
  unassigned?: boolean
  categories?: string[]
  priority?: string[]
  itemType?: string
  q?: string
  sort?: 'priority' | 'activity' | 'due' | 'created'
  limit?: number
  includeClosed?: boolean
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/** Cards across every board the viewer can see ("My work" and the agent's sweep). */
export async function listWorkItems(workspaceId: string, viewer: BoardViewer, filter: InboxFilter = {}) {
  const boards = await listBoards(workspaceId, viewer, filter.conversationId ? { conversationId: filter.conversationId } : {})
  const boardIds = boards
    .filter((b) => (!filter.boardId || b.id === filter.boardId || b.slug === filter.boardId) && (!filter.itemType || b.itemType === filter.itemType))
    .map((b) => b.id)
  if (!boardIds.length) return { items: [], boards }
  const categories = (filter.categories ?? []).filter((c) => (COLUMN_CATEGORIES as readonly string[]).includes(c))
  const rows = await db.workItem.findMany({
    where: {
      workspaceId,
      boardId: { in: boardIds },
      archivedAt: null,
      ...(filter.assigneeUserId ? { assigneeUserId: filter.assigneeUserId } : {}),
      ...(filter.assigneeAgentRef ? { assigneeAgentRef: filter.assigneeAgentRef } : {}),
      ...(filter.unassigned ? { assigneeUserId: null, assigneeAgentRef: null } : {}),
      ...(filter.priority?.length ? { priority: { in: filter.priority } } : {}),
      ...(categories.length
        ? { column: { category: { in: categories } } }
        : filter.includeClosed ? {} : { column: { category: { notIn: ['done', 'dismissed'] } } }),
      ...(filter.q ? { OR: [{ title: { contains: filter.q } }, { key: { contains: filter.q.toUpperCase() } }] } : {}),
    },
    include: { column: true, board: true },
    orderBy: filter.sort === 'created' ? { createdAt: 'desc' } : filter.sort === 'due' ? { dueAt: 'asc' } : { lastActivityAt: 'desc' },
    take: Math.min(filter.limit ?? 200, 500),
  })
  let items = rows.map(serializeItem)
  if (filter.sort === 'priority' || !filter.sort) {
    items = items.sort((a: any, b: any) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      || new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
  }
  if (filter.sort === 'due') items = items.sort((a: any, b: any) => (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity))
  return { items, boards }
}

// ─── Summary and health ──────────────────────────────────────────────────────

export interface HealthIssue {
  type: 'sla_breach' | 'wip_exceeded' | 'stale' | 'unassigned' | 'overdue' | 'needs_attention'
  itemId?: string
  key?: string
  title?: string
  columnId?: string
  column?: string
  detail: string
}

function healthFor(board: any, items: any[], staleHours = 72): { issues: HealthIssue[] } {
  const issues: HealthIssue[] = []
  const now = new Date()
  const columns = new Map<string, any>(board.columns.map((c: any) => [c.id, c]))
  const perColumn = new Map<string, number>()
  for (const item of items) {
    if (item.archivedAt) continue
    perColumn.set(item.columnId, (perColumn.get(item.columnId) ?? 0) + 1)
    const column = columns.get(item.columnId)
    if (!column || isClosed(column.category)) continue
    const base = { itemId: item.id, key: item.key, title: item.title, columnId: column.id, column: column.name }
    const inColumn = hoursBetween(item.columnEnteredAt, now)
    if (column.slaHours && inColumn > column.slaHours) {
      issues.push({ type: 'sla_breach', ...base, detail: `${Math.round(inColumn)}h in ${column.name} (SLA ${column.slaHours}h)` })
    }
    if (item.dueAt && new Date(item.dueAt) < now) issues.push({ type: 'overdue', ...base, detail: `Due ${new Date(item.dueAt).toISOString().slice(0, 10)}` })
    const idle = hoursBetween(item.lastActivityAt, now)
    if (idle > staleHours && column.category !== 'backlog') issues.push({ type: 'stale', ...base, detail: `No activity for ${Math.round(idle)}h` })
    if (!item.assigneeUserId && !item.assigneeAgentRef && !column.agentRef && (column.category === 'active' || column.category === 'review')) {
      issues.push({ type: 'unassigned', ...base, detail: `Unassigned in ${column.name}` })
    }
    if (column.category === 'waiting' && /attention/i.test(column.name)) {
      issues.push({ type: 'needs_attention', ...base, detail: `Waiting in ${column.name}` })
    }
  }
  for (const column of board.columns) {
    const count = perColumn.get(column.id) ?? 0
    if (column.wipLimit && count > column.wipLimit) {
      issues.push({ type: 'wip_exceeded', columnId: column.id, column: column.name, detail: `${count} cards, WIP limit ${column.wipLimit}` })
    }
  }
  return { issues }
}

/** Counts, throughput and cycle time for one board. */
export async function boardSummary(board: any, opts: { days?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90)
  const since = new Date(Date.now() - days * 86_400_000)
  const items = await db.workItem.findMany({ where: { boardId: board.id, archivedAt: null } })
  const columns = board.columns.slice().sort((a: any, b: any) => a.position - b.position)
  const byColumn = columns.map((c: any) => ({ column: c.name, category: c.category, count: items.filter((i: any) => i.columnId === c.id).length, wipLimit: c.wipLimit ?? null }))
  const open = items.filter((i: any) => !isClosed(columns.find((c: any) => c.id === i.columnId)?.category ?? ''))
  const done = items.filter((i: any) => i.completedAt && new Date(i.completedAt) >= since)
  const cycle = done.map((i: any) => hoursBetween(i.createdAt, i.completedAt)).sort((a: number, b: number) => a - b)
  const median = cycle.length ? cycle[Math.floor(cycle.length / 2)] : null
  const created = items.filter((i: any) => new Date(i.createdAt) >= since).length
  const byAssignee = new Map<string, number>()
  for (const i of open) {
    const k = i.assigneeAgentRef ?? (i.assigneeUserId ? `user:${i.assigneeUserId}` : 'unassigned')
    byAssignee.set(k, (byAssignee.get(k) ?? 0) + 1)
  }
  const { issues } = healthFor(board, items)
  return {
    board: { id: board.id, name: board.name, itemType: board.itemType, conversationId: board.conversationId ?? null },
    windowDays: days,
    open: open.length,
    createdInWindow: created,
    doneInWindow: done.length,
    medianCycleHours: median === null ? null : Math.round(median * 10) / 10,
    byColumn,
    byAssignee: [...byAssignee.entries()].map(([assignee, count]) => ({ assignee, count })),
    issueCounts: issues.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.type]: (acc[i.type] ?? 0) + 1 }), {}),
  }
}

/** What needs a nudge across boards: SLA breaches, WIP, stale and unassigned cards. */
export async function boardHealth(workspaceId: string, viewer: BoardViewer, opts: { boardId?: string; conversationId?: string; staleHours?: number } = {}) {
  const boards = (await listBoards(workspaceId, viewer, opts.conversationId ? { conversationId: opts.conversationId } : {}))
    .filter((b) => !opts.boardId || b.id === opts.boardId || b.slug === opts.boardId)
  const out: Array<{ boardId: string; board: string; channelName: string | null; issues: HealthIssue[] }> = []
  for (const b of boards) {
    const items = await db.workItem.findMany({ where: { boardId: b.id, archivedAt: null } })
    const { issues } = healthFor(b, items, opts.staleHours ?? 72)
    out.push({ boardId: b.id, board: b.name, channelName: b.channelName, issues })
  }
  return { boards: out, totalIssues: out.reduce((n, b) => n + b.issues.length, 0) }
}

// ─── Intake ──────────────────────────────────────────────────────────────────

/**
 * Create a card unless an open one already has this fingerprint, in which case
 * the event is recorded on it instead. Used by trigger card targets.
 */
export async function intakeWorkItem(board: any, input: ItemInput, actor: BoardActor) {
  if (input.fingerprint) {
    const existing = await db.workItem.findFirst({
      where: { boardId: board.id, fingerprint: input.fingerprint, archivedAt: null },
      include: { column: true, board: { include: BOARD_INCLUDE } },
    })
    if (existing && !isClosed(existing.column.category)) {
      await recordEvent(existing, 'occurrence', actor, { title: input.title })
      await db.workItem.update({ where: { id: existing.id }, data: { lastActivityAt: new Date() } })
      await publishBoard(board, { action: 'item.updated', itemId: existing.id })
      return { item: serializeItem(existing), created: false }
    }
  }
  return { item: await createWorkItem(board, input, actor), created: true }
}

// ─── Problems ────────────────────────────────────────────────────────────────

export interface ProblemInput {
  title: string
  fingerprint: string
  environment?: string | null
  release?: string | null
  message?: string | null
  stack?: string | null
  url?: string | null
  userRef?: string | null
  context?: Record<string, unknown> | null
  occurredAt?: string | Date | null
  eventSubscriptionId?: string | null
  externalRef?: string | null
}

export type ProblemOutcome = 'new' | 'occurrence' | 'regressed' | 'dismissed'

function problemDescription(input: ProblemInput): string | null {
  const parts = [
    input.message ? input.message.slice(0, 2000) : null,
    input.stack ? `\`\`\`\n${input.stack.slice(0, 4000)}\n\`\`\`` : null,
    input.url ? `Seen at ${input.url}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join('\n\n') : null
}

/**
 * One error report. Reports with the same fingerprint share a card: the
 * first opens it, repeats add occurrences, and a repeat after the card was
 * resolved reopens it. Dismissed cards stay dismissed and only count.
 */
export async function reportProblem(board: any, input: ProblemInput, actor: BoardActor): Promise<{ item: any; outcome: ProblemOutcome; occurrences: number }> {
  if (board.itemType !== 'problem') throw bad('not_problem_board', `${board.name} is not a problem board`)
  const fingerprint = str(input.fingerprint, 500)
  if (!fingerprint) throw bad('invalid_input', 'fingerprint is required')
  const title = str(input.title, 300) ?? fingerprint
  const occurredAt = dateOrNull(input.occurredAt) ?? new Date()

  let item = await db.workItem.findFirst({
    where: { boardId: board.id, fingerprint, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { column: true, board: { include: BOARD_INCLUDE } },
  })
  let outcome: ProblemOutcome
  if (!item) {
    const created = await createWorkItem(board, {
      title,
      description: problemDescription(input),
      fingerprint,
      source: 'problem',
      externalRef: input.externalRef ?? null,
      eventSubscriptionId: input.eventSubscriptionId ?? null,
      fields: { ...(input.environment ? { environment: input.environment } : {}), ...(input.release ? { release: input.release } : {}) },
    }, actor)
    item = await getItemRow(board.workspaceId, created.id)
    outcome = 'new'
  } else if (item.column.category === 'dismissed') {
    outcome = 'dismissed'
  } else if (item.column.category === 'done') {
    await moveWorkItem(item, { column: defaultColumn(board).id }, actor)
    item = await getItemRow(board.workspaceId, item.id)
    outcome = 'regressed'
  } else {
    outcome = 'occurrence'
  }

  await db.problemOccurrence.create({
    data: {
      workItemId: item.id,
      workspaceId: board.workspaceId,
      fingerprint,
      environment: str(input.environment, 100) ?? null,
      release: str(input.release, 100) ?? null,
      message: str(input.message, 10_000) ?? null,
      stack: str(input.stack, 50_000) ?? null,
      url: str(input.url, 2000) ?? null,
      userRef: str(input.userRef, 200) ?? null,
      occurrenceContext: input.context ?? null,
      occurredAt,
    },
  })
  const occurrences = await db.problemOccurrence.count({ where: { workItemId: item.id } })
  const fields = { ...(item.fields ?? {}), occurrences, lastSeenAt: occurredAt.toISOString(), ...(input.release ? { release: input.release } : {}) }
  await db.workItem.update({ where: { id: item.id }, data: { fields, lastActivityAt: new Date() } })
  if (outcome !== 'new') {
    await recordEvent(item, 'occurrence', actor, { environment: input.environment ?? null, release: input.release ?? null, outcome })
    await publishBoard(board, { action: 'item.updated', itemId: item.id })
  }
  if (outcome === 'regressed' && item.threadRootMessageId) {
    await postActivity(item, board, `${item.key} happened again after it was resolved${input.release ? ` (release ${input.release})` : ''}, so it was reopened.`)
  }
  return { item: serializeItem({ ...item, fields }), outcome, occurrences }
}

/** Recent occurrences, and counts by day and environment. */
export async function problemOccurrences(item: any, opts: { limit?: number; days?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const since = new Date(Date.now() - (opts.days ?? 14) * 86_400_000)
  const [recent, total, window] = await Promise.all([
    db.problemOccurrence.findMany({ where: { workItemId: item.id }, orderBy: { occurredAt: 'desc' }, take: limit }),
    db.problemOccurrence.count({ where: { workItemId: item.id } }),
    db.problemOccurrence.findMany({ where: { workItemId: item.id, occurredAt: { gte: since } }, select: { occurredAt: true, environment: true, release: true } }),
  ])
  const byDay: Record<string, number> = {}
  const byEnvironment: Record<string, number> = {}
  const releases = new Set<string>()
  for (const o of window) {
    const day = new Date(o.occurredAt).toISOString().slice(0, 10)
    byDay[day] = (byDay[day] ?? 0) + 1
    const env = o.environment ?? 'unknown'
    byEnvironment[env] = (byEnvironment[env] ?? 0) + 1
    if (o.release) releases.add(o.release)
  }
  const first = await db.problemOccurrence.findFirst({ where: { workItemId: item.id }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } })
  return {
    key: item.key,
    total,
    firstSeenAt: first?.occurredAt ?? null,
    lastSeenAt: recent[0]?.occurredAt ?? null,
    byDay,
    byEnvironment,
    releases: [...releases],
    recent: recent.map((o: any) => ({
      id: o.id,
      occurredAt: o.occurredAt,
      environment: o.environment,
      release: o.release,
      message: o.message,
      stack: o.stack ? String(o.stack).slice(0, 4000) : null,
      url: o.url,
      userRef: o.userRef,
      context: o.occurrenceContext ?? null,
    })),
  }
}

// ─── Post hooks ──────────────────────────────────────────────────────────────

let hooksRegistered = false

/**
 * Keep card history current from every message: replies in a card thread
 * bump activity and link the agent session behind them; a card key mentioned
 * anywhere links that message; a failed agent run sends the card to "needs
 * attention" and tags the person who started it.
 */
export function registerWorkBoardHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true
  registerAfterPostHook(async (result, ctx) => {
    const row = result.row
    if (!row || row.deletedAt) return
    if (row.threadRootId) {
      const item = await db.workItem.findFirst({ where: { threadRootMessageId: row.threadRootId }, include: { column: true, board: { include: BOARD_INCLUDE } } })
      if (item) {
        await db.workItem.update({ where: { id: item.id }, data: { lastActivityAt: new Date() } })
        if (row.authorType === 'agent' && row.agentSessionId) {
          await upsertLink(item, { kind: 'chat_session', refId: row.agentSessionId, conversationId: row.conversationId, reason: 'agent_run', snippet: row.authorAgentRef?.name ?? 'Agent' }, { agentRef: agentRefFor(row.authorAgentRef?.projectId ?? null) })
        }
        if (row.authorType === 'agent' && row.agentStatus === 'error' && (ctx.settled || ctx.origin === 'agent')) {
          await sendToNeedsAttention(item, row)
        }
      }
    }
    if (row.authorType === 'system') return
    const keys = cardKeysIn(row.text)
    if (!keys.length) return
    const items = await db.workItem.findMany({ where: { workspaceId: row.workspaceId, key: { in: keys } }, select: { id: true, workspaceId: true, threadRootMessageId: true } })
    for (const item of items) {
      if (item.threadRootMessageId && (row.threadRootId === item.threadRootMessageId || row.id === item.threadRootMessageId)) continue
      await upsertLink(item, {
        kind: 'message',
        refId: row.id,
        conversationId: row.conversationId,
        reason: 'mention',
        snippet: String(row.text ?? '').slice(0, 280),
      }, row.authorType === 'agent' ? { agentRef: agentRefFor(row.authorAgentRef?.projectId ?? null) } : { userId: row.authorUserId ?? null })
    }
  })
}

/**
 * An agent's run in a card thread finished. When that agent holds the card and
 * left it where it was, whoever is watching the card hears about it: a failed
 * run goes to "needs attention", and a run that ended without moving the card
 * records `agent_stopped`, so the assigner is not left waiting on a card
 * nobody is working.
 */
export async function noteCardRunEnded(run: { threadRootId: string | null; projectId: string | null; messageId: string; agentStatus: string }): Promise<void> {
  if (!run.threadRootId) return
  const item = await db.workItem.findFirst({
    where: { threadRootMessageId: run.threadRootId, archivedAt: null },
    include: { column: true, board: { include: BOARD_INCLUDE } },
  })
  if (!item) return
  const agentRef = agentRefFor(run.projectId)
  if ((item.assigneeAgentRef ?? item.column.agentRef) !== agentRef) return
  if (run.agentStatus === 'error') {
    const failed = await db.conversationMessage.findUnique({ where: { id: run.messageId } })
    if (failed) await sendToNeedsAttention(item, failed)
    return
  }
  if (item.column.category !== 'backlog' && item.column.category !== 'active') return
  await recordEvent(item, 'agent_stopped', { agentRef }, {
    column: item.column.name,
    messageId: run.messageId,
    ...(run.agentStatus === 'stopped' ? { reason: 'stopped by a person' } : {}),
  })
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function sendToNeedsAttention(item: any, failed: any) {
  const earlier = await db.workItemEvent.findMany({
    where: { workItemId: item.id, type: 'agent_failed', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    select: { eventData: true },
  })
  const messageIdOf = (data: any) => (typeof data === 'string' ? safeJson(data) : data)?.messageId
  if (earlier.some((e: any) => messageIdOf(e.eventData) === failed.id)) return
  await recordEvent(item, 'agent_failed', { agentRef: agentRefFor(failed.authorAgentRef?.projectId ?? null) }, { messageId: failed.id })
  const column = item.board.columns.find((c: any) => c.category === 'waiting' && /attention/i.test(c.name))
    ?? item.board.columns.find((c: any) => c.category === 'waiting')
  if (column && column.id !== item.columnId) {
    const now = new Date()
    await db.workItem.update({ where: { id: item.id }, data: { columnId: column.id, columnEnteredAt: now, lastActivityAt: now, completedAt: null } })
    await recordEvent(item, 'moved', {}, { from: { columnId: item.columnId, column: item.column.name }, to: { columnId: column.id, column: column.name }, reason: 'agent_failed' })
    await refreshCardMessage(item.id)
  }
  const chain = failed.agentChain && typeof failed.agentChain === 'object' ? failed.agentChain : null
  const owner = item.assigneeUserId ?? chain?.originUserId ?? item.createdById
  if (item.threadRootMessageId && item.conversationId) {
    const result = await postMessage({
      conversationId: item.conversationId,
      authorType: 'system',
      threadRootId: item.threadRootMessageId,
      systemMentions: true,
      text: `${owner ? `<@u:${owner}> ` : ''}The agent working ${item.key} stopped with an error${column ? `, so the card moved to ${column.name}` : ''}. Reply here or reassign it.`,
    })
    void afterMessagePosted(result, { actorUserId: null, origin: 'system' })
  }
  await publishBoard(item.board, { action: 'item.moved', itemId: item.id })
}

export type { ColumnCategory }
