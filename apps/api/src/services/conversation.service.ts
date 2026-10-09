// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace channels: conversations (public/private channels, DMs, group
 * DMs, the #activity feed), members (people and agents), messages, threads,
 * reactions, and read state. Every mutation publishes a realtime event on the
 * conversation bus.
 */

import { prisma } from '../lib/prisma'
import { accessibleProjectsWhere, loadAccess as loadAuthzAccess } from '../lib/authz'
import { publishConversationEvent } from '../lib/conversation-bus'
import { parseMentions, renderMentionsAsText, type AgentTarget, type ParsedMention } from './conversation-mentions'
import { assertNativeChat } from './chat-mode'
import type { AgentChain } from './conversation-agent-chain'
import { normalizeBuddyLook, type BuddyLook } from '../../../../packages/shared-app/src/buddy-look'

const db = prisma as any

/** A stored look (JSON text) read leniently; null when nothing usable is saved. */
export function storedAgentBuddyLook(raw: string | null | undefined): BuddyLook | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? normalizeBuddyLook(value) : null
  } catch {
    return null
  }
}

export const MAX_MESSAGE_CHARS = 40_000
export const MAX_GROUP_DM_PARTICIPANTS = 9
export const DEFAULT_CHANNEL_SLUG = 'general'
export const ACTIVITY_CHANNEL_SLUG = 'activity'

export type ConversationKind = 'public' | 'private' | 'dm' | 'group_dm' | 'activity'
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export class ConversationError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 502, public code: string, message: string) {
    super(message)
  }
}

const notFound = () => new ConversationError(404, 'not_found', 'Conversation not found')

// ─── Access ──────────────────────────────────────────────────────────────────

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const member = await db.member.findFirst({
    where: { workspaceId, userId, projectId: null },
    select: { role: true },
  })
  return (member?.role as WorkspaceRole) ?? null
}

export interface ConversationAccess {
  conversation: any
  role: WorkspaceRole
  membership: any | null
}

export function isOpenKind(kind: string): boolean {
  return kind === 'public' || kind === 'activity'
}

export function canRead(access: Pick<ConversationAccess, 'conversation' | 'membership'>): boolean {
  return isOpenKind(access.conversation.kind) || !!access.membership
}

/** #activity only takes system posts at the top level; people discuss items in threads. */
export function canPost(access: ConversationAccess, opts: { threadReply?: boolean } = {}): boolean {
  if (!canRead(access)) return false
  if (access.role === 'viewer') return false
  if (access.conversation.archivedAt) return false
  return access.conversation.kind !== 'activity' || !!opts.threadReply
}

export function canManage(access: ConversationAccess): boolean {
  if (access.role === 'owner' || access.role === 'admin') return true
  return access.membership?.role === 'owner'
}

export async function loadAccess(conversationId: string, userId: string): Promise<ConversationAccess> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation) throw notFound()
  const role = await getWorkspaceRole(conversation.workspaceId, userId)
  if (!role) throw notFound()
  await assertNativeChat(conversation.workspaceId)
  const membership = await db.conversationMember.findFirst({
    where: { conversationId, userId },
  })
  const access = { conversation, role, membership }
  if (!canRead(access)) throw notFound()
  return access
}

export async function requirePost(
  conversationId: string,
  userId: string,
  opts: { threadReply?: boolean } = {},
): Promise<ConversationAccess> {
  const access = await loadAccess(conversationId, userId)
  if (!canPost(access, opts)) {
    throw new ConversationError(403, 'forbidden', access.conversation.archivedAt
      ? 'This conversation is archived'
      : 'You cannot post in this conversation')
  }
  return access
}

export async function requireManage(conversationId: string, userId: string): Promise<ConversationAccess> {
  const access = await loadAccess(conversationId, userId)
  if (!canManage(access)) throw new ConversationError(403, 'forbidden', 'Only channel owners and workspace admins can do that')
  return access
}

/** User ids that may receive events for a conversation; null means every workspace member. */
export async function conversationAudience(conversation: { id: string; kind: string }): Promise<string[] | null> {
  if (isOpenKind(conversation.kind)) return null
  const members = await db.conversationMember.findMany({
    where: { conversationId: conversation.id, memberType: 'user' },
    select: { userId: true },
  })
  return members.map((m: any) => m.userId).filter(Boolean)
}

async function publish(conversation: { id: string; kind: string; workspaceId: string }, event: Record<string, unknown>) {
  const audience = await conversationAudience(conversation)
  publishConversationEvent(conversation.workspaceId, { conversationId: conversation.id, ...event } as any, audience)
}

// ─── Serialization ───────────────────────────────────────────────────────────

const USER_SELECT = { id: true, name: true, email: true, image: true }

export const MESSAGE_INCLUDE = {
  authorUser: { select: USER_SELECT },
  reactions: { select: { emoji: true, userId: true } },
  attachments: {
    select: { id: true, name: true, mimeType: true, size: true, width: true, height: true, storageKey: true },
  },
  pin: { select: { pinnedById: true, createdAt: true } },
}

export type AttachmentUrlBuilder = (attachment: { id: string; storageKey: string }) => string
let attachmentUrl: AttachmentUrlBuilder = (a) => `/api/conversation-files/${a.id}`
export function setAttachmentUrlBuilder(builder: AttachmentUrlBuilder): void {
  attachmentUrl = builder
}

export function summarizeReactions(reactions: { emoji: string; userId: string }[] = []) {
  const byEmoji = new Map<string, string[]>()
  for (const r of reactions) {
    const users = byEmoji.get(r.emoji) ?? []
    users.push(r.userId)
    byEmoji.set(r.emoji, users)
  }
  return Array.from(byEmoji, ([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
}

export function serializeMessage(row: any) {
  const deleted = !!row.deletedAt
  return {
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    seq: row.seq,
    threadRootId: row.threadRootId ?? null,
    replyCount: row.replyCount ?? 0,
    lastReplyAt: row.lastReplyAt ?? null,
    alsoSentToChannel: !!row.alsoSentToChannel,
    authorType: row.authorType,
    author: row.authorType === 'user' && row.authorUser
      ? { id: row.authorUser.id, name: row.authorUser.name || row.authorUser.email, image: row.authorUser.image ?? null }
      : row.authorType === 'user' && row.blocks?.externalAuthor
        ? {
            id: `ext:${row.blocks.externalAuthor.provider}:${row.blocks.externalAuthor.id}`,
            name: row.blocks.externalAuthor.name || 'Someone',
            image: null,
          }
        : null,
    authorUserId: row.authorUserId ?? null,
    authorAgent: row.authorAgentRef ?? null,
    text: deleted ? '' : row.text,
    blocks: deleted ? null : row.blocks ?? null,
    clientMsgId: row.clientMsgId ?? null,
    agentSessionId: row.agentSessionId ?? null,
    agentStatus: row.agentStatus ?? null,
    reactions: deleted ? [] : summarizeReactions(row.reactions),
    attachments: deleted
      ? []
      : (row.attachments ?? []).map((a: any) => ({
          id: a.id, name: a.name, mimeType: a.mimeType, size: a.size,
          width: a.width ?? null, height: a.height ?? null, url: attachmentUrl(a),
        })),
    pinned: !deleted && row.pin ? { byId: row.pin.pinnedById, at: row.pin.createdAt } : null,
    editedAt: row.editedAt ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
  }
}

export type SerializedMessage = ReturnType<typeof serializeMessage>

export function serializeConversation(row: any, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as ConversationKind,
    name: row.name ?? null,
    slug: row.slug ?? null,
    topic: row.topic ?? null,
    lastSeq: row.lastSeq,
    lastMessageAt: row.lastMessageAt ?? null,
    archivedAt: row.archivedAt ?? null,
    createdById: row.createdById ?? null,
    createdAt: row.createdAt,
    ...extra,
  }
}

// ─── Conversations ───────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/** Idempotently create #general and #activity for a workspace. */
export async function ensureDefaultConversations(workspaceId: string, creatorUserId?: string | null) {
  const defaults = [
    { slug: DEFAULT_CHANNEL_SLUG, name: 'general', kind: 'public', topic: 'Team-wide conversation' },
    { slug: ACTIVITY_CHANNEL_SLUG, name: 'activity', kind: 'activity', topic: 'What agents and teammates are doing across the workspace' },
  ]
  const result: any[] = []
  for (const d of defaults) {
    const existing = await db.conversation.findFirst({ where: { workspaceId, slug: d.slug } })
    if (existing) {
      result.push(existing)
      continue
    }
    try {
      result.push(await db.conversation.create({
        data: { workspaceId, ...d, createdById: creatorUserId ?? null },
      }))
    } catch {
      const raced = await db.conversation.findFirst({ where: { workspaceId, slug: d.slug } })
      if (raced) result.push(raced)
    }
  }
  return result
}

/** Everyone in the workspace is in #general. */
async function ensureGeneralMembership(general: any, userId: string) {
  if (!(await getWorkspaceRole(general.workspaceId, userId))) return null
  try {
    return await db.conversationMember.create({
      data: { conversationId: general.id, memberType: 'user', userId, lastReadSeq: general.lastSeq, lastReadAt: new Date() },
    })
  } catch {
    return db.conversationMember.findFirst({ where: { conversationId: general.id, userId } })
  }
}

export async function getActivityConversation(workspaceId: string) {
  const [, activity] = await ensureDefaultConversations(workspaceId)
  return activity
}

/**
 * Validates `notifyConversationId` for schedules and tasks. `undefined`
 * means "unchanged", null/'' clears it. The conversation must belong to the
 * workspace, accept posts, and be readable by the user who configured it.
 */
export async function resolveNotifyConversation(
  workspaceId: string,
  value: unknown,
  userId: string,
): Promise<string | null | undefined> {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ConversationError(400, 'invalid_field', 'notifyConversationId must be a string or null')
  const invalid = () => new ConversationError(400, 'invalid_notify_conversation', 'Choose a channel or DM in this workspace that you can post to')
  const bySlug = await db.conversation.findFirst({
    where: { workspaceId, slug: value.replace(/^#/, '').toLowerCase() },
    select: { id: true },
  })
  let access: ConversationAccess
  try {
    access = await loadAccess(bySlug?.id ?? value, userId)
  } catch {
    throw invalid()
  }
  const { conversation } = access
  if (conversation.workspaceId !== workspaceId || conversation.kind === 'activity' || conversation.archivedAt) throw invalid()
  return conversation.id
}

/**
 * Validates `notifyThreadRootId`: a top-level message in the notify channel.
 * `undefined` means "unchanged", null/'' clears it.
 */
export async function resolveNotifyThread(
  conversationId: string | null | undefined,
  value: unknown,
): Promise<string | null | undefined> {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ConversationError(400, 'invalid_field', 'notifyThreadRootId must be a string or null')
  const root = conversationId
    ? await db.conversationMessage.findFirst({
        where: { id: value, conversationId, threadRootId: null, deletedAt: null },
        select: { id: true },
      })
    : null
  if (!root) {
    throw new ConversationError(400, 'invalid_notify_thread', 'Choose the first message of a thread in the channel that receives results')
  }
  return root.id
}

/** Display name for an agent: the project's name, or the workspace agent's profile name. */
export async function agentDisplayName(workspaceId: string, projectId: string | null): Promise<string> {
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
    return project?.name ?? 'Agent'
  }
  const profile = await db.workspaceAgentProfile.findUnique({ where: { workspaceId }, select: { name: true } }).catch(() => null)
  return profile?.name || 'Shogo'
}

/** Avatar for an agent: the workspace agent's profile image, or the project's thumbnail. */
export async function agentIconUrl(workspaceId: string, projectId: string | null): Promise<string | null> {
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { thumbnailUrl: true } }).catch(() => null)
    return project?.thumbnailUrl ?? null
  }
  const profile = await db.workspaceAgentProfile.findUnique({ where: { workspaceId }, select: { avatarUrl: true } }).catch(() => null)
  return profile?.avatarUrl ?? null
}

async function uniqueSlug(workspaceId: string, base: string): Promise<string> {
  const root = base || 'channel'
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`
    const clash = await db.conversation.findFirst({ where: { workspaceId, slug }, select: { id: true } })
    if (!clash) return slug
  }
  return `${root}-${crypto.randomUUID().slice(0, 6)}`
}

async function participantNames(workspaceId: string, conversationIds: string[], viewerId: string) {
  if (!conversationIds.length) return { byConversation: new Map<string, any[]>(), orphanedDirectIds: new Set<string>() }
  const rows = await db.conversationMember.findMany({
    where: { conversationId: { in: conversationIds } },
    include: { user: { select: USER_SELECT } },
  })
  const projectIds = rows.filter((r: any) => r.memberType === 'agent' && r.projectId).map((r: any) => r.projectId)
  const projects = projectIds.length
    ? await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
    : []
  const projectNames = new Map<string, string>(projects.map((p: any) => [p.id, p.name]))
  // Conversations whose agent belongs to a project that no longer exists.
  const orphanedDirectIds = new Set<string>(
    rows
      .filter((r: any) => r.memberType === 'agent' && r.projectId && !projectNames.has(r.projectId))
      .map((r: any) => r.conversationId),
  )
  const workspaceAgentName = rows.some((r: any) => r.memberType === 'agent' && !r.projectId)
    ? await agentDisplayName(workspaceId, null)
    : null
  const byConversation = new Map<string, any[]>()
  for (const r of rows) {
    if (r.memberType === 'user' && r.userId === viewerId) continue
    const list = byConversation.get(r.conversationId) ?? []
    list.push(r.memberType === 'agent'
      ? { type: 'agent', projectId: r.projectId ?? null, name: r.projectId ? projectNames.get(r.projectId) ?? 'Agent' : workspaceAgentName }
      : { type: 'user', id: r.user?.id ?? r.userId, name: r.user?.name || r.user?.email || 'Unknown', image: r.user?.image ?? null })
    byConversation.set(r.conversationId, list)
  }
  return { byConversation, orphanedDirectIds }
}

export async function listConversationsForUser(workspaceId: string, userId: string) {
  const [general] = await ensureDefaultConversations(workspaceId)
  const memberships = await db.conversationMember.findMany({
    where: { userId, conversation: { workspaceId } },
  })
  if (general && !memberships.some((m: any) => m.conversationId === general.id)) {
    const joined = await ensureGeneralMembership(general, userId)
    if (joined) memberships.push(joined)
  }
  const membershipByConv = new Map<string, any>(memberships.map((m: any) => [m.conversationId, m]))
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      OR: [
        { kind: { in: ['public', 'activity'] } },
        { id: { in: memberships.map((m: any) => m.conversationId) } },
      ],
    },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'asc' }],
  })

  const directIds = conversations.filter((c: any) => c.kind === 'dm' || c.kind === 'group_dm').map((c: any) => c.id)
  const { byConversation: participants, orphanedDirectIds } = await participantNames(workspaceId, directIds, userId)
  // Agent DMs left behind by a project deleted before cleanup existed: archive them now.
  const orphanedDmIds = conversations
    .filter((c: any) => c.kind === 'dm' && !c.archivedAt && orphanedDirectIds.has(c.id))
    .map((c: any) => c.id)
  if (orphanedDmIds.length) {
    const archivedAt = new Date()
    await db.conversation.updateMany({ where: { id: { in: orphanedDmIds } }, data: { archivedAt } }).catch(() => {})
    for (const c of conversations) if (orphanedDmIds.includes(c.id)) c.archivedAt = archivedAt
  }
  const mentionCounts = await unreadMentionCounts(userId, memberships)
  const unread = await unreadCounts(userId, conversations, membershipByConv)
  const lastMessages = await lastMessagePreviews(directIds)

  return conversations.map((c: any) => {
    const m = membershipByConv.get(c.id)
    return serializeConversation(c, {
      joined: !!m,
      starred: !!m?.starred,
      muted: !!m?.muted,
      notifyLevel: m?.notifyLevel ?? 'default',
      lastReadSeq: m?.lastReadSeq ?? 0,
      unreadCount: unread.get(c.id) ?? 0,
      mentionCount: mentionCounts.get(c.id) ?? 0,
      participants: participants.get(c.id) ?? undefined,
      lastMessage: lastMessages.get(c.id) ?? undefined,
    })
  })
}

const LAST_MESSAGE_PREVIEW_CHARS = 140

export interface LastMessage {
  preview: string
  authorId: string | null
  authorType: string
  createdAt: Date
}

/**
 * The newest top-level message of each conversation, for the DM list's second
 * line. One grouped query finds the newest seq per conversation, one more
 * reads those rows, so cost does not grow with message history.
 */
export async function lastMessagePreviews(conversationIds: string[]): Promise<Map<string, LastMessage>> {
  const out = new Map<string, LastMessage>()
  if (!conversationIds.length) return out
  const latest = await db.conversationMessage.groupBy({
    by: ['conversationId'],
    where: { conversationId: { in: conversationIds }, deletedAt: null, threadRootId: null },
    _max: { seq: true },
  })
  if (!latest.length) return out
  const rows = await db.conversationMessage.findMany({
    where: { OR: latest.map((l: any) => ({ conversationId: l.conversationId, seq: l._max.seq })), deletedAt: null },
    select: { conversationId: true, text: true, authorUserId: true, authorType: true, createdAt: true },
  })
  for (const row of rows as any[]) {
    const preview = renderMentionsAsText(row.text ?? '').replace(/\s+/g, ' ').trim().slice(0, LAST_MESSAGE_PREVIEW_CHARS)
    out.set(row.conversationId, { preview, authorId: row.authorUserId ?? null, authorType: row.authorType, createdAt: row.createdAt })
  }
  return out
}

/** Unread messages in the channel view: thread replies only count when also sent to the channel. */
async function unreadCounts(userId: string, conversations: any[], membershipByConv: Map<string, any>) {
  const counts = new Map<string, number>()
  const behind = conversations.filter((c: any) => {
    const m = membershipByConv.get(c.id)
    return m && c.lastSeq > m.lastReadSeq
  })
  if (!behind.length) return counts
  const rows = await db.conversationMessage.groupBy({
    by: ['conversationId'],
    where: {
      OR: behind.map((c: any) => ({ conversationId: c.id, seq: { gt: membershipByConv.get(c.id).lastReadSeq } })),
      AND: [
        { OR: [{ threadRootId: null }, { alsoSentToChannel: true }] },
        { OR: [{ authorUserId: null }, { authorUserId: { not: userId } }] },
      ],
      deletedAt: null,
    },
    _count: { _all: true },
  })
  for (const row of rows as any[]) counts.set(row.conversationId, row._count._all)
  return counts
}

async function unreadMentionCounts(userId: string, memberships: any[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!memberships.length) return counts
  const lastRead = new Map<string, number>(memberships.map((m: any) => [m.conversationId, m.lastReadSeq]))
  const oldest = memberships.some((m: any) => !m.lastReadAt)
    ? null
    : new Date(Math.min(...memberships.map((m: any) => new Date(m.lastReadAt).getTime())))
  const mentions = await db.conversationMention.findMany({
    where: {
      targetUserId: userId,
      ...(oldest ? { createdAt: { gte: oldest } } : {}),
      message: { conversationId: { in: memberships.map((m: any) => m.conversationId) }, deletedAt: null },
    },
    select: { message: { select: { conversationId: true, seq: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  for (const { message } of mentions) {
    if (message.seq > (lastRead.get(message.conversationId) ?? 0)) {
      counts.set(message.conversationId, (counts.get(message.conversationId) ?? 0) + 1)
    }
  }
  return counts
}

export async function getConversationForUser(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  const members = await listMembers(access.conversation.workspaceId, conversationId)
  return serializeConversation(access.conversation, {
    joined: !!access.membership,
    starred: !!access.membership?.starred,
    muted: !!access.membership?.muted,
    notifyLevel: access.membership?.notifyLevel ?? 'default',
    lastReadSeq: access.membership?.lastReadSeq ?? 0,
    canPost: canPost(access),
    canReply: canPost(access, { threadReply: true }),
    canManage: canManage(access),
    members,
  })
}

async function listMembers(workspaceId: string, conversationId: string) {
  const rows = await db.conversationMember.findMany({
    where: { conversationId },
    include: { user: { select: USER_SELECT } },
    orderBy: { createdAt: 'asc' },
  })
  const projectIds = rows.filter((r: any) => r.projectId).map((r: any) => r.projectId)
  const projects = projectIds.length
    ? await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
    : []
  const names = new Map<string, string>(projects.map((p: any) => [p.id, p.name]))
  const workspaceAgentName = rows.some((r: any) => r.memberType === 'agent' && !r.projectId)
    ? await agentDisplayName(workspaceId, null)
    : null
  return rows.map((r: any) => r.memberType === 'agent'
    ? {
        id: r.id, type: 'agent' as const, projectId: r.projectId ?? null,
        name: r.projectId ? names.get(r.projectId) ?? 'Agent' : workspaceAgentName,
        agentTrigger: r.agentTrigger, agentKeywords: r.agentKeywords ?? null, agentMuted: !!r.agentMuted,
      }
    : {
        id: r.id, type: 'user' as const, userId: r.userId, role: r.role,
        name: r.user?.name || r.user?.email || 'Unknown', image: r.user?.image ?? null,
      })
}

export interface CreateChannelInput {
  workspaceId: string
  userId: string
  name: string
  kind?: 'public' | 'private'
  topic?: string | null
  memberUserIds?: string[]
}

export async function createChannel(input: CreateChannelInput) {
  const role = await getWorkspaceRole(input.workspaceId, input.userId)
  if (!role) throw new ConversationError(403, 'forbidden', 'No access to this workspace')
  if (role === 'viewer') throw new ConversationError(403, 'forbidden', 'Viewers cannot create channels')
  const name = input.name?.trim()
  const base = slugify(name ?? '')
  if (!name || !base) throw new ConversationError(400, 'invalid_name', 'Channel name is required')
  const kind = input.kind === 'private' ? 'private' : 'public'
  const slug = await uniqueSlug(input.workspaceId, base)
  const conversation = await db.conversation.create({
    data: {
      workspaceId: input.workspaceId,
      kind,
      name: slug,
      slug,
      topic: input.topic?.trim() || null,
      createdById: input.userId,
    },
  })
  const invitees = await filterWorkspaceMembers(input.workspaceId, input.memberUserIds ?? [])
  await db.conversationMember.create({
    data: { conversationId: conversation.id, memberType: 'user', userId: input.userId, role: 'owner' },
  })
  for (const uid of invitees) {
    if (uid === input.userId) continue
    await db.conversationMember.create({ data: { conversationId: conversation.id, memberType: 'user', userId: uid } })
  }
  await publish(conversation, { type: 'conversation.created', conversation: serializeConversation(conversation) })
  return conversation
}

async function filterWorkspaceMembers(workspaceId: string, userIds: string[]): Promise<string[]> {
  const unique = [...new Set(userIds.filter((id) => typeof id === 'string' && id))]
  if (!unique.length) return []
  const members = await db.member.findMany({
    where: { workspaceId, projectId: null, userId: { in: unique } },
    select: { userId: true },
  })
  return members.map((m: any) => m.userId)
}

export async function updateConversation(
  conversationId: string,
  userId: string,
  patch: { name?: string; topic?: string | null; archived?: boolean; kind?: 'public' | 'private' },
) {
  const access = await loadAccess(conversationId, userId)
  const conv = access.conversation
  const isDirect = conv.kind === 'dm' || conv.kind === 'group_dm'
  const data: Record<string, unknown> = {}
  if (patch.topic !== undefined) {
    if (!canPost(access) && !canManage(access)) throw new ConversationError(403, 'forbidden', 'You cannot edit this topic')
    data.topic = patch.topic?.toString().trim().slice(0, 500) || null
  }
  if (patch.name !== undefined || patch.archived !== undefined || patch.kind !== undefined) {
    if (isDirect || conv.kind === 'activity') throw new ConversationError(400, 'invalid', 'This conversation cannot be renamed or archived')
    if (!canManage(access)) throw new ConversationError(403, 'forbidden', 'Only channel owners and workspace admins can do that')
    if (conv.slug === DEFAULT_CHANNEL_SLUG && (patch.archived || patch.kind === 'private')) {
      throw new ConversationError(400, 'invalid', '#general cannot be archived or made private')
    }
  }
  if (patch.name !== undefined) {
    const base = slugify(patch.name)
    if (!base) throw new ConversationError(400, 'invalid_name', 'Channel name is required')
    if (base !== conv.slug) {
      const slug = await uniqueSlug(conv.workspaceId, base)
      data.slug = slug
      data.name = slug
    }
  }
  if (patch.archived !== undefined) data.archivedAt = patch.archived ? new Date() : null
  if (patch.kind !== undefined && patch.kind !== conv.kind) data.kind = patch.kind
  if (!Object.keys(data).length) return conv
  const before = await conversationAudience(conv)
  const updated = await db.conversation.update({ where: { id: conversationId }, data })
  const after = await conversationAudience(updated)
  const audience = before === null || after === null ? null : [...new Set([...before, ...after])]
  publishConversationEvent(updated.workspaceId, {
    type: 'conversation.updated', conversationId, conversation: serializeConversation(updated),
  }, audience)
  return updated
}

export async function joinConversation(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  if (!isOpenKind(access.conversation.kind)) throw new ConversationError(403, 'forbidden', 'Private conversations require an invitation')
  if (access.membership) return access.membership
  const membership = await db.conversationMember.create({
    data: { conversationId, memberType: 'user', userId, lastReadSeq: access.conversation.lastSeq, lastReadAt: new Date() },
  })
  await publish(access.conversation, { type: 'member.joined', userId })
  return membership
}

export async function leaveConversation(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  if (access.conversation.kind === 'dm') throw new ConversationError(400, 'invalid', 'You cannot leave a direct message')
  if (access.conversation.slug === DEFAULT_CHANNEL_SLUG && isOpenKind(access.conversation.kind)) {
    throw new ConversationError(400, 'invalid', 'Everyone in the workspace is in #general')
  }
  if (!access.membership) return
  const audience = await conversationAudience(access.conversation)
  await db.conversationMember.delete({ where: { id: access.membership.id } })
  publishConversationEvent(access.conversation.workspaceId, { type: 'member.left', conversationId, userId }, audience)
}

export async function addUserMembers(conversationId: string, actorId: string, userIds: string[]) {
  const access = await loadAccess(conversationId, actorId)
  const conv = access.conversation
  if (conv.kind === 'dm' || conv.kind === 'activity') throw new ConversationError(400, 'invalid', 'Members cannot be added to this conversation')
  if (!canPost(access) && !canManage(access)) throw new ConversationError(403, 'forbidden', 'You cannot add members here')
  const valid = await filterWorkspaceMembers(conv.workspaceId, userIds)
  const existing = await db.conversationMember.findMany({
    where: { conversationId, userId: { in: valid } },
    select: { userId: true },
  })
  const have = new Set(existing.map((e: any) => e.userId))
  const added: string[] = []
  for (const uid of valid) {
    if (have.has(uid)) continue
    await db.conversationMember.create({ data: { conversationId, memberType: 'user', userId: uid } })
    added.push(uid)
  }
  if (added.length) await publish(conv, { type: 'member.joined', userIds: added })
  return added
}

/**
 * An agent adds workspace members to a channel it can see (public, or private
 * with the agent as a member; the caller resolves visibility). Accepts user
 * ids or emails. Returns the user ids that were newly added.
 */
export async function addUserMembersAsAgent(conversation: { id: string; kind: string; workspaceId: string; archivedAt?: Date | null }, users: string[]) {
  if (conversation.kind !== 'public' && conversation.kind !== 'private') {
    throw new ConversationError(400, 'invalid', 'People can only be added to channels')
  }
  if (conversation.archivedAt) throw new ConversationError(400, 'archived', 'This channel is archived')
  const wanted = users.map((u) => String(u).trim()).filter(Boolean)
  if (!wanted.length) return []
  const members = await db.member.findMany({
    where: {
      workspaceId: conversation.workspaceId,
      projectId: null,
      OR: [{ userId: { in: wanted } }, { user: { email: { in: [...new Set([...wanted, ...wanted.map((w) => w.toLowerCase())])] } } }],
    },
    select: { userId: true },
  })
  const valid: string[] = [...new Set<string>(members.map((m: any) => m.userId as string))]
  const existing = await db.conversationMember.findMany({
    where: { conversationId: conversation.id, userId: { in: valid } },
    select: { userId: true },
  })
  const have = new Set(existing.map((e: any) => e.userId))
  const added: string[] = []
  for (const uid of valid) {
    if (have.has(uid)) continue
    await db.conversationMember.create({ data: { conversationId: conversation.id, memberType: 'user', userId: uid } })
    added.push(uid)
  }
  if (added.length) await publish(conversation, { type: 'member.joined', userIds: added })
  return added
}

export async function removeMember(conversationId: string, actorId: string, memberId: string) {
  const access = await requireManage(conversationId, actorId)
  const row = await db.conversationMember.findFirst({ where: { id: memberId, conversationId } })
  if (!row) throw new ConversationError(404, 'not_found', 'Member not found')
  const audience = await conversationAudience(access.conversation)
  await db.conversationMember.delete({ where: { id: row.id } })
  publishConversationEvent(access.conversation.workspaceId, {
    type: 'member.left', conversationId, userId: row.userId ?? undefined, memberId,
  }, audience)
}

export async function updateMembership(
  conversationId: string,
  userId: string,
  patch: { starred?: boolean; muted?: boolean; notifyLevel?: string },
) {
  const access = await loadAccess(conversationId, userId)
  if (!access.membership) throw new ConversationError(400, 'not_member', 'Join the conversation first')
  const data: Record<string, unknown> = {}
  if (typeof patch.starred === 'boolean') data.starred = patch.starred
  if (typeof patch.muted === 'boolean') data.muted = patch.muted
  if (patch.notifyLevel && ['default', 'all', 'mentions', 'none'].includes(patch.notifyLevel)) data.notifyLevel = patch.notifyLevel
  return db.conversationMember.update({ where: { id: access.membership.id }, data })
}

// ─── Direct messages ─────────────────────────────────────────────────────────

export async function openDirectConversation(workspaceId: string, userId: string, otherUserIds: string[]) {
  const role = await getWorkspaceRole(workspaceId, userId)
  if (!role) throw new ConversationError(403, 'forbidden', 'No access to this workspace')
  const others = (await filterWorkspaceMembers(workspaceId, otherUserIds)).filter((id) => id !== userId)
  if (!others.length && otherUserIds.some((id) => id !== userId)) {
    throw new ConversationError(400, 'invalid_members', 'Those people are not in this workspace')
  }
  if (others.length + 1 > MAX_GROUP_DM_PARTICIPANTS) {
    throw new ConversationError(400, 'too_many', `Group DMs are limited to ${MAX_GROUP_DM_PARTICIPANTS} people. Create a private channel instead.`)
  }
  const participants = [...new Set([userId, ...others])].sort()
  const dmKey = `u:${participants.join(',')}`
  const kind = participants.length <= 2 ? 'dm' : 'group_dm'
  return findOrCreateDirect(workspaceId, dmKey, kind, userId, async (conversationId) => {
    for (const uid of participants) {
      await db.conversationMember.create({ data: { conversationId, memberType: 'user', userId: uid } })
    }
  })
}

export async function openAgentConversation(workspaceId: string, userId: string, target: AgentTarget) {
  const role = await getWorkspaceRole(workspaceId, userId)
  if (!role) throw new ConversationError(403, 'forbidden', 'No access to this workspace')
  await assertAgentInWorkspace(workspaceId, target)
  const dmKey = `a:${userId}:${target.projectId ?? 'ws'}`
  return findOrCreateDirect(workspaceId, dmKey, 'dm', userId, async (conversationId) => {
    await db.conversationMember.create({ data: { conversationId, memberType: 'user', userId } })
    await db.conversationMember.create({
      data: { conversationId, memberType: 'agent', projectId: target.projectId, agentTrigger: 'all' },
    })
  })
}

async function findOrCreateDirect(
  workspaceId: string,
  dmKey: string,
  kind: 'dm' | 'group_dm',
  creatorId: string,
  addMembers: (conversationId: string) => Promise<void>,
) {
  const existing = await db.conversation.findFirst({ where: { workspaceId, dmKey } })
  if (existing) return existing
  let conversation: any
  try {
    conversation = await db.conversation.create({ data: { workspaceId, kind, dmKey, createdById: creatorId } })
  } catch {
    const raced = await db.conversation.findFirst({ where: { workspaceId, dmKey } })
    if (raced) return raced
    throw new ConversationError(409, 'conflict', 'Could not open the conversation')
  }
  await addMembers(conversation.id)
  await publish(conversation, { type: 'conversation.created', conversation: serializeConversation(conversation) })
  return conversation
}

// ─── Agent members ───────────────────────────────────────────────────────────

/** With `viewerId`, the agent's project must also be readable by that user (restricted projects). */
export async function assertAgentInWorkspace(workspaceId: string, target: AgentTarget, viewerId?: string) {
  if (!target.projectId) return
  const project = await db.project.findUnique({ where: { id: target.projectId }, select: { workspaceId: true } })
  const readable = !!project && project.workspaceId === workspaceId && (!viewerId
    || (await loadAuthzAccess({ userId: viewerId, via: 'session' }, { projectId: target.projectId })).permissions.has('project:read'))
  if (!readable) {
    throw new ConversationError(400, 'invalid_agent', 'That agent is not in this workspace')
  }
}

export const AGENT_TRIGGERS = ['mention', 'keyword', 'all', 'auto']

/** Silence (or restore) an agent's channel triggers; a direct @mention still reaches it. */
export async function setAgentMuted(conversationId: string, actorId: string, target: AgentTarget, muted: boolean): Promise<void> {
  const access = await loadAccess(conversationId, actorId)
  if (!canPost(access)) throw new ConversationError(403, 'forbidden', 'You cannot change agents here')
  const member = await db.conversationMember.findFirst({
    where: { conversationId, memberType: 'agent', projectId: target.projectId },
  })
  if (!member) throw new ConversationError(404, 'not_found', 'That agent is not in this channel')
  if (member.agentMuted !== muted) {
    await db.conversationMember.update({ where: { id: member.id }, data: { agentMuted: muted } })
    await publish(access.conversation, { type: 'member.joined', agent: { projectId: target.projectId } })
  }
}

export async function addAgentMember(
  conversationId: string,
  actorId: string,
  input: { projectId: string | null; trigger?: string; keywords?: string | null },
) {
  const access = await loadAccess(conversationId, actorId)
  if (!canPost(access)) throw new ConversationError(403, 'forbidden', 'You cannot add agents here')
  await assertAgentInWorkspace(access.conversation.workspaceId, { projectId: input.projectId }, actorId)
  const trigger = AGENT_TRIGGERS.includes(input.trigger ?? '') ? input.trigger! : 'mention'
  const existing = await db.conversationMember.findFirst({
    where: { conversationId, memberType: 'agent', projectId: input.projectId },
  })
  const data = { agentTrigger: trigger, agentKeywords: input.keywords?.trim() || null }
  const row = existing
    ? await db.conversationMember.update({ where: { id: existing.id }, data })
    : await db.conversationMember.create({
        data: { conversationId, memberType: 'agent', projectId: input.projectId, ...data },
      })
  await publish(access.conversation, { type: 'member.joined', agent: { projectId: input.projectId } })
  return row
}

export async function listAgentMembers(conversationId: string) {
  return db.conversationMember.findMany({ where: { conversationId, memberType: 'agent' } })
}

/**
 * Takes a deleted project's agent out of team chat: its DMs are archived (history is
 * kept), it leaves every channel and group DM, and clients are told to refresh their
 * lists and agent pickers. `workspaceId` is passed so the pickers refresh even when the
 * agent was never in a conversation.
 */
export async function removeProjectAgent(projectId: string, workspaceId?: string | null): Promise<void> {
  const rows = await db.conversationMember.findMany({
    where: { memberType: 'agent', projectId },
    include: { conversation: true },
  })
  const workspaces = new Set<string>(workspaceId ? [workspaceId] : [])
  for (const row of rows) {
    const conversation = row.conversation
    workspaces.add(conversation.workspaceId)
    if (conversation.kind === 'dm') {
      if (conversation.archivedAt) continue
      const audience = await conversationAudience(conversation)
      const updated = await db.conversation.update({ where: { id: conversation.id }, data: { archivedAt: new Date() } })
      publishConversationEvent(updated.workspaceId, {
        type: 'conversation.updated', conversationId: updated.id, conversation: serializeConversation(updated),
      } as any, audience)
    } else {
      await db.conversationMember.delete({ where: { id: row.id } })
      await publish(conversation, { type: 'member.left', agent: { projectId } })
    }
  }
  for (const ws of workspaces) {
    publishConversationEvent(ws, { type: 'agent.updated', projectId } as any)
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface PostMessageInput {
  conversationId: string
  text: string
  authorType?: 'user' | 'agent' | 'bot' | 'system'
  authorUserId?: string | null
  authorAgentRef?: { projectId: string | null; name: string; iconUrl?: string | null } | null
  botId?: string | null
  threadRootId?: string | null
  alsoSentToChannel?: boolean
  clientMsgId?: string | null
  attachmentIds?: string[]
  blocks?: unknown
  agentStatus?: string | null
  agentSessionId?: string | null
  externalRef?: string | null
  externalThreadRef?: string | null
  /** Agent @mention chain this message belongs to; `rootMessageId` is filled in here. */
  agentChain?: AgentChain | null
  /** Record mentions (and notify) on a system message. Off by default so join/leave notices stay quiet. */
  systemMentions?: boolean
  createdAt?: Date
}

export interface PostMessageResult {
  message: SerializedMessage
  row: any
  conversation: any
  mentions: ParsedMention[]
  duplicate: boolean
}

/** Add a user mention for each member of every mentioned group (members get notified as if mentioned). */
export async function expandGroupMentions(workspaceId: string, mentions: ParsedMention[]): Promise<ParsedMention[]> {
  const groupIds = mentions.flatMap((m) => (m.targetType === 'group' ? [m.groupId] : []))
  if (!groupIds.length) return mentions
  const members = await db.userGroupMember.findMany({
    where: { groupId: { in: groupIds }, group: { workspaceId } },
    select: { userId: true },
  })
  const seen = new Set(mentions.flatMap((m) => (m.targetType === 'user' ? [m.userId] : [])))
  const extra: ParsedMention[] = []
  for (const { userId } of members) {
    if (seen.has(userId)) continue
    seen.add(userId)
    extra.push({ targetType: 'user', userId })
  }
  return [...mentions, ...extra]
}

export async function postMessage(input: PostMessageInput): Promise<PostMessageResult> {
  const text = (input.text ?? '').toString()
  const attachmentIds = (input.attachmentIds ?? []).filter((id) => typeof id === 'string')
  if (!text.trim() && !attachmentIds.length && input.authorType !== 'agent') {
    throw new ConversationError(400, 'empty', 'Message is empty')
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new ConversationError(400, 'too_long', `Messages are limited to ${MAX_MESSAGE_CHARS} characters`)
  }

  const conversation = await db.conversation.findUnique({ where: { id: input.conversationId } })
  if (!conversation) throw notFound()

  if (input.clientMsgId) {
    const existing = await db.conversationMessage.findFirst({
      where: { conversationId: conversation.id, clientMsgId: input.clientMsgId },
      include: MESSAGE_INCLUDE,
    })
    if (existing) {
      return { message: serializeMessage(existing), row: existing, conversation, mentions: [], duplicate: true }
    }
  }
  if (input.externalRef) {
    const existing = await db.conversationMessage.findFirst({
      where: { conversationId: conversation.id, externalRef: input.externalRef },
      include: MESSAGE_INCLUDE,
    })
    if (existing) {
      return { message: serializeMessage(existing), row: existing, conversation, mentions: [], duplicate: true }
    }
  }

  let root: any = null
  if (input.threadRootId) {
    root = await db.conversationMessage.findUnique({ where: { id: input.threadRootId } })
    if (!root || root.conversationId !== conversation.id) {
      throw new ConversationError(400, 'invalid_thread', 'Thread not found in this conversation')
    }
    if (root.threadRootId) root = await db.conversationMessage.findUnique({ where: { id: root.threadRootId } })
  }

  const now = input.createdAt ?? new Date()
  const bumped = await db.conversation.update({
    where: { id: conversation.id },
    data: { lastSeq: { increment: 1 }, lastMessageAt: now },
    select: { lastSeq: true },
  })
  const mentions = input.authorType === 'system' && !input.systemMentions
    ? []
    : await expandGroupMentions(conversation.workspaceId, parseMentions(text))

  const id = crypto.randomUUID()
  const row = await db.conversationMessage.create({
    data: {
      id,
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      seq: bumped.lastSeq,
      threadRootId: root?.id ?? null,
      alsoSentToChannel: !!(root && input.alsoSentToChannel),
      authorType: input.authorType ?? 'user',
      authorUserId: input.authorUserId ?? null,
      authorAgentRef: input.authorAgentRef ?? undefined,
      botId: input.botId ?? null,
      text,
      blocks: input.blocks ?? undefined,
      clientMsgId: input.clientMsgId ?? null,
      agentStatus: input.agentStatus ?? null,
      agentSessionId: input.agentSessionId ?? null,
      externalRef: input.externalRef ?? null,
      externalThreadRef: input.externalThreadRef ?? null,
      agentChain: input.agentChain ? { ...input.agentChain, rootMessageId: root?.id ?? id } : undefined,
      createdAt: now,
      mentions: mentions.length
        ? {
            create: mentions.map((m) => ({
              targetType: m.targetType,
              targetUserId: m.targetType === 'user' ? m.userId : null,
              projectId: m.targetType === 'agent' ? m.projectId : null,
            })),
          }
        : undefined,
    },
  })

  if (attachmentIds.length && input.authorUserId) {
    await db.conversationAttachment.updateMany({
      where: {
        id: { in: attachmentIds },
        conversationId: conversation.id,
        uploaderUserId: input.authorUserId,
        messageId: null,
      },
      data: { messageId: row.id },
    })
  }

  if (input.authorUserId && input.authorType !== 'system') {
    await db.conversationMember.updateMany({
      where: { conversationId: conversation.id, userId: input.authorUserId, lastReadSeq: { lt: bumped.lastSeq } },
      data: { lastReadSeq: bumped.lastSeq, lastReadAt: now },
    })
  }

  const full = await db.conversationMessage.findUnique({ where: { id: row.id }, include: MESSAGE_INCLUDE })
  const message = serializeMessage(full)
  await publish(conversation, { type: 'message.created', message })

  if (root) {
    const updatedRoot = await db.conversationMessage.update({
      where: { id: root.id },
      data: { replyCount: { increment: 1 }, lastReplyAt: now },
      include: MESSAGE_INCLUDE,
    })
    await publish(conversation, { type: 'message.updated', message: serializeMessage(updatedRoot) })
  }

  return { message, row: full, conversation, mentions, duplicate: false }
}

type TextSettledHook = (row: any) => void
const textSettledHooks: TextSettledHook[] = []

/**
 * Run `hook` when a message's final text changes after posting: a person
 * edits it, or an agent reply finishes. Not called for the initial post
 * (see `registerAfterPostHook`) or while an agent reply is streaming.
 */
export function onMessageTextSettled(hook: TextSettledHook): void {
  textSettledHooks.push(hook)
}

export async function updateMessageInternal(
  messageId: string,
  data: Record<string, unknown>,
  opts: { moveToEnd?: boolean } = {},
) {
  // A reply that finished after other messages landed belongs after them, since the client
  // orders by seq. It is announced as a new message so unread counts and badges follow it.
  let moved = false
  if (opts.moveToEnd) {
    const current = await db.conversationMessage.findUnique({ where: { id: messageId }, select: { conversationId: true, seq: true } })
    const later = current
      ? await db.conversationMessage.findFirst({
          where: { conversationId: current.conversationId, seq: { gt: current.seq }, deletedAt: null },
          select: { id: true },
        })
      : null
    if (current && later) {
      const bumped = await db.conversation.update({
        where: { id: current.conversationId },
        data: { lastSeq: { increment: 1 }, lastMessageAt: new Date() },
        select: { lastSeq: true },
      })
      data = { ...data, seq: bumped.lastSeq }
      moved = true
    }
  }
  const row = await db.conversationMessage.update({ where: { id: messageId }, data, include: MESSAGE_INCLUDE })
  const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
  const message = serializeMessage(row)
  if (conversation) await publish(conversation, moved ? { type: 'message.created', message, moved: true } : { type: 'message.updated', message })
  if ('text' in data && !row.deletedAt && row.agentStatus !== 'running') {
    for (const hook of textSettledHooks) hook(row)
  }
  return message
}

/** Re-derive a message's mention rows from `text` (edits, finished agent replies). */
export async function replaceMentions(messageId: string, workspaceId: string, text: string): Promise<ParsedMention[]> {
  await db.conversationMention.deleteMany({ where: { messageId } })
  const mentions = await expandGroupMentions(workspaceId, parseMentions(text))
  for (const m of mentions) {
    await db.conversationMention.create({
      data: {
        messageId,
        targetType: m.targetType,
        targetUserId: m.targetType === 'user' ? m.userId : null,
        projectId: m.targetType === 'agent' ? m.projectId : null,
      },
    })
  }
  return mentions
}

export async function editMessage(messageId: string, userId: string, text: string) {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row || row.deletedAt) throw new ConversationError(404, 'not_found', 'Message not found')
  await requirePost(row.conversationId, userId)
  if (row.authorType !== 'user' || row.authorUserId !== userId) {
    throw new ConversationError(403, 'forbidden', 'You can only edit your own messages')
  }
  const next = (text ?? '').toString()
  if (!next.trim()) throw new ConversationError(400, 'empty', 'Message is empty')
  if (next.length > MAX_MESSAGE_CHARS) throw new ConversationError(400, 'too_long', 'Message is too long')
  await replaceMentions(messageId, row.workspaceId, next)
  await db.conversationMessageEmbedding.deleteMany({ where: { messageId } })
  return updateMessageInternal(messageId, { text: next, editedAt: new Date() })
}

export async function deleteMessage(messageId: string, userId: string) {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row || row.deletedAt) throw new ConversationError(404, 'not_found', 'Message not found')
  const access = await loadAccess(row.conversationId, userId)
  const own = row.authorType === 'user' && row.authorUserId === userId
  if (!own && !canManage(access)) throw new ConversationError(403, 'forbidden', 'You can only delete your own messages')
  await db.conversationReaction.deleteMany({ where: { messageId } })
  await db.conversationMention.deleteMany({ where: { messageId } })
  return updateMessageInternal(messageId, { text: '', blocks: null, deletedAt: new Date() })
}

export interface ListMessagesOptions {
  beforeSeq?: number
  afterSeq?: number
  limit?: number
  threadRootId?: string
}

export async function listMessages(conversationId: string, userId: string, opts: ListMessagesOptions = {}) {
  await loadAccess(conversationId, userId)
  return listMessagesUnchecked(conversationId, opts)
}

export async function listMessagesUnchecked(conversationId: string, opts: ListMessagesOptions = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  if (opts.threadRootId) {
    const root = await db.conversationMessage.findUnique({ where: { id: opts.threadRootId }, include: MESSAGE_INCLUDE })
    if (!root || root.conversationId !== conversationId) throw new ConversationError(404, 'not_found', 'Thread not found')
    const replies = await db.conversationMessage.findMany({
      where: {
        conversationId,
        threadRootId: root.id,
        ...(opts.afterSeq !== undefined ? { seq: { gt: opts.afterSeq } } : {}),
      },
      include: MESSAGE_INCLUDE,
      orderBy: { seq: 'asc' },
      take: 500,
    })
    return { root: serializeMessage(root), messages: replies.map(serializeMessage), hasMore: false }
  }

  const where: Record<string, unknown> = {
    conversationId,
    OR: [{ threadRootId: null }, { alsoSentToChannel: true }],
  }
  if (opts.afterSeq !== undefined) {
    const rows = await db.conversationMessage.findMany({
      where: { conversationId, seq: { gt: opts.afterSeq } },
      include: MESSAGE_INCLUDE,
      orderBy: { seq: 'asc' },
      take: limit + 1,
    })
    return { messages: rows.slice(0, limit).map(serializeMessage), hasMore: rows.length > limit }
  }
  if (opts.beforeSeq !== undefined) where.seq = { lt: opts.beforeSeq }
  const rows = await db.conversationMessage.findMany({
    where,
    include: MESSAGE_INCLUDE,
    orderBy: { seq: 'desc' },
    take: limit + 1,
  })
  const page = rows.slice(0, limit).reverse()
  return { messages: page.map(serializeMessage), hasMore: rows.length > limit }
}

export async function getMessage(messageId: string, userId: string) {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId }, include: MESSAGE_INCLUDE })
  if (!row) throw new ConversationError(404, 'not_found', 'Message not found')
  await loadAccess(row.conversationId, userId)
  return serializeMessage(row)
}

export interface ReactionAddedEvent {
  message: any
  conversation: any
  reactorId: string
  emoji: string
}
type ReactionHook = (event: ReactionAddedEvent) => void | Promise<void>
const reactionHooks: ReactionHook[] = []

export function onReactionAdded(hook: ReactionHook): void {
  reactionHooks.push(hook)
}

export async function setReaction(messageId: string, userId: string, emoji: string, on: boolean) {
  const clean = (emoji ?? '').toString().trim()
  if (!clean || clean.length > 64) throw new ConversationError(400, 'invalid_emoji', 'Invalid emoji')
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row || row.deletedAt) throw new ConversationError(404, 'not_found', 'Message not found')
  const access = await loadAccess(row.conversationId, userId)
  if (access.role === 'viewer') throw new ConversationError(403, 'forbidden', 'Viewers cannot react')
  if (on) {
    const existing = await db.conversationReaction.findFirst({ where: { messageId, userId, emoji: clean } })
    if (!existing) {
      try {
        await db.conversationReaction.create({ data: { messageId, userId, emoji: clean } })
        for (const hook of reactionHooks) {
          void Promise.resolve(hook({ message: row, conversation: access.conversation, reactorId: userId, emoji: clean }))
            .catch((err) => console.warn('[conversations] reaction hook failed:', err?.message))
        }
      } catch {
        // Concurrent duplicate toggle; the unique index already holds the reaction.
      }
    }
  } else {
    await db.conversationReaction.deleteMany({ where: { messageId, userId, emoji: clean } })
  }
  const reactions = await db.conversationReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } })
  const summary = summarizeReactions(reactions)
  await publish(access.conversation, { type: 'reaction.changed', messageId, reactions: summary })
  return summary
}

/** Set the read position. An explicit `seq` may move it backwards ("mark unread"). */
export async function markRead(conversationId: string, userId: string, seq?: number) {
  const access = await loadAccess(conversationId, userId)
  if (!access.membership) return { lastReadSeq: 0 }
  const lastSeq = access.conversation.lastSeq
  const target = seq !== undefined && Number.isFinite(seq)
    ? Math.min(Math.max(0, Math.floor(seq)), lastSeq)
    : lastSeq
  const updated = await db.conversationMember.update({
    where: { id: access.membership.id },
    data: { lastReadSeq: target, lastReadAt: new Date() },
  })
  const unreadCount = target >= lastSeq ? 0 : await db.conversationMessage.count({
    where: {
      conversationId,
      seq: { gt: target },
      deletedAt: null,
      AND: [
        { OR: [{ threadRootId: null }, { alsoSentToChannel: true }] },
        { OR: [{ authorUserId: null }, { authorUserId: { not: userId } }] },
      ],
    },
  })
  publishConversationEvent(access.conversation.workspaceId, {
    type: 'read', conversationId, userId, seq: updated.lastReadSeq, unreadCount,
  }, [userId])
  if (target >= lastSeq) {
    const { count } = await db.chatInboxItem.updateMany({
      where: { userId, conversationId, readAt: null, kind: { not: 'thread' } },
      data: { readAt: new Date() },
    })
    if (count) {
      const unread = await db.chatInboxItem.count({ where: { workspaceId: access.conversation.workspaceId, userId, readAt: null } })
      publishConversationEvent(access.conversation.workspaceId, { type: 'inbox.read', unread }, [userId])
    }
  }
  return { lastReadSeq: updated.lastReadSeq, unreadCount }
}

// ─── Mentionables ────────────────────────────────────────────────────────────

export async function listMentionables(workspaceId: string, userId: string) {
  const readable = await accessibleProjectsWhere({ userId, via: 'session' }, workspaceId)
  const [members, projects, profile] = await Promise.all([
    db.member.findMany({
      where: { workspaceId, projectId: null },
      include: { user: { select: USER_SELECT } },
    }),
    db.project.findMany({
      where: { AND: [{ workspaceId }, readable] },
      select: { id: true, name: true, description: true, buddyLook: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    db.workspaceAgentProfile.findUnique({ where: { workspaceId }, select: { name: true, avatarUrl: true, buddyLook: true } }).catch(() => null),
  ])
  const seen = new Set<string>()
  const people = []
  for (const m of members) {
    if (!m.user || seen.has(m.user.id)) continue
    seen.add(m.user.id)
    people.push({ id: m.user.id, name: m.user.name || m.user.email, email: m.user.email, image: m.user.image ?? null, role: m.role })
  }
  return {
    people,
    agents: [
      { key: 'ws', projectId: null, name: profile?.name || 'Shogo', description: 'Workspace agent', image: profile?.avatarUrl ?? null, buddyLook: storedAgentBuddyLook(profile?.buddyLook) },
      ...projects.map((p: any) => ({
        key: `p:${p.id}`, projectId: p.id, name: p.name, description: p.description ?? null, image: null, buddyLook: storedAgentBuddyLook(p.buddyLook),
      })),
    ],
  }
}
