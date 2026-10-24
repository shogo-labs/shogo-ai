// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The unified inbox: DMs and comments, read from our own tables.
 *
 * The provider's own guidance for this is explicit — webhooks write your inbox
 * database, API calls are for sending and backfill — because polling every
 * customer's threads for each render is thousands of mostly empty requests.
 * So this module has exactly two ways in:
 *
 *   1. `ingestSocialEvent`, called by the webhook handler on both ends of the
 *      relay (the cloud for its own scope, the desktop for a local one). Every
 *      row is unique on the provider's id, so a redelivered webhook, a retried
 *      provider delivery and an overlapping sweep are one row.
 *   2. `backfillInbox`, the same sweep the provider documents: list
 *      conversations (and commented posts) for our profile, then their
 *      messages (and comments). It runs after connect and on demand, and it is
 *      what fills the gaps a missed webhook leaves — including the window
 *      before a desktop existed.
 *
 * Sending is the only thing that goes back out: `replyToConversation` and
 * `replyToComment`, both with an `Idempotency-Key` so a retry after a lost
 * response cannot deliver twice.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'
import { ensureProfile } from './profiles.service'
import { meterOutboundMessage } from './usage.service'

const db = prisma as any

/** Provider events this module writes rows for (a subset of what it receives). */
export const INBOX_EVENT_TYPES = new Set([
  'conversation.started',
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'comment.received',
])

export interface IngestInput {
  workspaceId: string
  /** Provider event name (`message.received`, …). */
  type: string
  /** The provider block for this event (`message`, `comment`, `conversation`). */
  detail?: unknown
  /** The whole verified payload, which is where `conversation` and `post` live. */
  payload?: unknown
  account?: { zernioAccountId: string; platform: string; username: string } | null
  occurredAt?: Date
}

export interface IngestResult {
  handled: boolean
  conversationId?: string
  messageId?: string
  commentId?: string
  /** True when this write was the first time we saw the provider row. */
  created?: boolean
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** The account row a payload's provider account id names, if we hold it. */
async function resolveAccountId(workspaceId: string, zernioAccountId: string | null): Promise<string | null> {
  if (!zernioAccountId) return null
  const row = await db.socialAccount.findFirst({
    where: { workspaceId, zernioAccountId },
    select: { id: true },
  })
  return row?.id ?? null
}

function preview(text: string | null): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat
}

/**
 * Upsert one thread. Returns null when the provider conversation id already
 * belongs to another workspace, which would mean two tenants were handed the
 * same provider resource — never take it over.
 */
async function upsertConversation(args: {
  workspaceId: string
  providerConversationId: string
  platform: string
  accountId: string | null
  participant?: { id?: unknown; name?: unknown; picture?: unknown } | null
  status?: unknown
  lastMessageAt?: Date | null
  lastMessagePreview?: string | null
  unreadCount?: number | null
}): Promise<{ id: string; created: boolean } | null> {
  const existing = await db.socialConversation.findUnique({
    where: { zernioConversationId: args.providerConversationId },
    select: { id: true, workspaceId: true },
  })
  if (existing && existing.workspaceId !== args.workspaceId) return null

  const participant = args.participant ?? {}
  const base: Record<string, unknown> = {
    workspaceId: args.workspaceId,
    platform: args.platform,
  }
  if (args.accountId) base.accountId = args.accountId
  const participantId = str(participant.id)
  const participantName = str(participant.name)
  const participantPicture = str(participant.picture)
  if (participantId) base.participantId = participantId
  if (participantName) base.participantName = participantName
  if (participantPicture) base.participantPicture = participantPicture
  const status = str(args.status)
  if (status) base.status = status
  if (args.lastMessageAt) base.lastMessageAt = args.lastMessageAt
  if (args.lastMessagePreview !== undefined && args.lastMessagePreview !== null) {
    base.lastMessagePreview = args.lastMessagePreview
  }
  // The provider's unread count seeds a thread we have never seen. On a thread
  // we already track it is *not* re-applied: our own counter is incremented by
  // incoming events, so overwriting it from a sweep double-counts.
  const initialUnreadCount =
    typeof args.unreadCount === 'number' && Number.isFinite(args.unreadCount)
      ? Math.max(0, args.unreadCount)
      : null

  if (!existing) {
    try {
      const row = await db.socialConversation.create({
        data: {
          ...base,
          ...(initialUnreadCount !== null ? { unreadCount: initialUnreadCount } : {}),
          zernioConversationId: args.providerConversationId,
        },
        select: { id: true },
      })
      return { id: row.id, created: true }
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
      // Lost a race with an overlapping sweep: fall through to the update.
      const raced = await db.socialConversation.findUnique({
        where: { zernioConversationId: args.providerConversationId },
        select: { id: true, workspaceId: true },
      })
      if (!raced || raced.workspaceId !== args.workspaceId) return null
      await db.socialConversation.update({ where: { id: raced.id }, data: base })
      return { id: raced.id, created: false }
    }
  }

  // Never let an older event walk a thread's recency (or its account) back.
  const current = await db.socialConversation.findUnique({
    where: { id: existing.id },
    select: { lastMessageAt: true, accountId: true },
  })
  if (current?.accountId) delete base.accountId
  if (args.lastMessageAt && current?.lastMessageAt && new Date(current.lastMessageAt) > args.lastMessageAt) {
    delete base.lastMessageAt
    delete base.lastMessagePreview
  }
  await db.socialConversation.update({ where: { id: existing.id }, data: base })
  return { id: existing.id, created: false }
}

/**
 * Upsert one message. `created` is what the unread count turns on: a
 * redelivered webhook must not count the same incoming message twice.
 */
async function upsertMessage(args: {
  workspaceId: string
  conversationId: string
  providerMessageId: string
  direction: string
  platform: string
  text: string | null
  attachments?: unknown
  author?: { id?: unknown; name?: unknown; username?: unknown; picture?: unknown } | null
  status?: string | null
  error?: string | null
  sentAt: Date
}): Promise<{ id: string; created: boolean } | null> {
  const existing = await db.socialMessage.findUnique({
    where: { zernioMessageId: args.providerMessageId },
    select: { id: true, workspaceId: true },
  })
  if (existing && existing.workspaceId !== args.workspaceId) return null

  const author = args.author ?? {}
  const base: Record<string, unknown> = {
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    direction: args.direction,
    platform: args.platform,
    sentAt: args.sentAt,
  }
  if (args.text !== null) base.text = args.text
  if (args.attachments !== undefined && args.attachments !== null) {
    const encoded = jsonOrNull(args.attachments)
    if (encoded) base.attachmentsJson = encoded
  }
  const authorId = str(author.id)
  const authorName = str(author.name)
  const authorUsername = str(author.username)
  const authorPicture = str(author.picture)
  if (authorId) base.authorId = authorId
  if (authorName) base.authorName = authorName
  if (authorUsername) base.authorUsername = authorUsername
  if (authorPicture) base.authorPicture = authorPicture
  if (args.status) base.status = args.status
  if (args.error) base.error = args.error

  if (!existing) {
    try {
      const row = await db.socialMessage.create({
        data: { ...base, zernioMessageId: args.providerMessageId },
        select: { id: true },
      })
      return { id: row.id, created: true }
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
      const raced = await db.socialMessage.findUnique({
        where: { zernioMessageId: args.providerMessageId },
        select: { id: true, workspaceId: true },
      })
      if (!raced || raced.workspaceId !== args.workspaceId) return null
      await db.socialMessage.update({ where: { id: raced.id }, data: base })
      return { id: raced.id, created: false }
    }
  }

  await db.socialMessage.update({ where: { id: existing.id }, data: base })
  return { id: existing.id, created: false }
}

async function upsertComment(args: {
  workspaceId: string
  detail: Record<string, any>
  payload: Record<string, any> | null
  providerAccountId: string | null
  occurredAt: Date
}): Promise<{ id: string; created: boolean } | null> {
  const detail = args.detail
  const providerCommentId = str(detail.id)
  if (!providerCommentId) return null

  const existing = await db.socialComment.findUnique({
    where: { zernioCommentId: providerCommentId },
    select: { id: true, workspaceId: true },
  })
  if (existing && existing.workspaceId !== args.workspaceId) return null

  const post = asRecord(detail.post) ?? asRecord(args.payload?.post) ?? {}
  const author = asRecord(detail.author) ?? {}
  const zernioPostId = str(post.id) ?? str(post.platformPostId) ?? str(detail.postId) ?? str(detail.platformPostId)
  if (!zernioPostId) return null
  const platformPostId = str(detail.platformPostId) ?? str(post.platformPostId) ?? zernioPostId

  // Link to our own post when this comment landed on something we published.
  const ourPost = await db.socialPost.findFirst({
    where: {
      workspaceId: args.workspaceId,
      OR: [{ zernioPostId }, { targets: { some: { platformPostId } } }],
    },
    select: { id: true },
  })

  const accountId = await resolveAccountId(
    args.workspaceId,
    args.providerAccountId ?? str(asRecord(detail.account)?.id),
  )
  const isOwn = author.isOwnAccount === true

  const base: Record<string, unknown> = {
    workspaceId: args.workspaceId,
    zernioPostId,
    platformPostId,
    platform: str(detail.platform) ?? str(post.platform) ?? 'unknown',
    text: typeof detail.text === 'string' ? detail.text : (typeof detail.message === 'string' ? detail.message : ''),
    occurredAt: dateOrNull(detail.createdTime) ?? args.occurredAt,
    isOwn,
  }
  if (ourPost?.id) base.postId = ourPost.id
  if (accountId) base.accountId = accountId
  const authorId = str(author.id)
  const authorName = str(author.name)
  const authorUsername = str(author.username)
  const authorPicture = str(author.picture)
  if (authorId) base.authorId = authorId
  if (authorName) base.authorName = authorName
  if (authorUsername) base.authorUsername = authorUsername
  if (authorPicture) base.authorPicture = authorPicture
  const permalink = str(detail.url)
  if (permalink) base.permalink = permalink
  if (typeof detail.isHidden === 'boolean') base.isHidden = detail.isHidden
  // Our own reply is not work: it lands already answered.
  if (isOwn) base.status = 'replied'

  if (!existing) {
    try {
      const row = await db.socialComment.create({
        data: { ...base, zernioCommentId: providerCommentId },
        select: { id: true },
      })
      return { id: row.id, created: true }
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
      const raced = await db.socialComment.findUnique({
        where: { zernioCommentId: providerCommentId },
        select: { id: true, workspaceId: true },
      })
      if (!raced || raced.workspaceId !== args.workspaceId) return null
      await db.socialComment.update({ where: { id: raced.id }, data: base })
      return { id: raced.id, created: false }
    }
  }

  await db.socialComment.update({ where: { id: existing.id }, data: base })
  return { id: existing.id, created: false }
}

/**
 * Write one provider event into the inbox. Never throws for a payload it does
 * not understand: an event we cannot place is not an error, and the caller has
 * already told the provider `200`.
 *
 * Idempotent on the provider ids, so a retried webhook, a replayed delivery and
 * an overlapping backfill all converge on one set of rows.
 */
export async function ingestSocialEvent(input: IngestInput): Promise<IngestResult> {
  if (!INBOX_EVENT_TYPES.has(input.type)) return { handled: false }

  const payload = asRecord(input.payload)
  const detail = asRecord(input.detail)
  const occurredAt = input.occurredAt ?? new Date()
  const providerAccountId = input.account?.zernioAccountId ?? null

  // ── comments ────────────────────────────────────────────────────────────
  if (input.type === 'comment.received') {
    const comment = detail ?? asRecord(payload?.comment)
    if (!comment) return { handled: false }
    const written = await upsertComment({
      workspaceId: input.workspaceId,
      detail: comment,
      payload,
      providerAccountId,
      occurredAt,
    })
    if (!written) return { handled: false }
    return { handled: true, commentId: written.id, created: written.created }
  }

  // ── conversations and messages ──────────────────────────────────────────
  const conversationBlock = asRecord(payload?.conversation)
  const message = detail ?? asRecord(payload?.message)
  const providerConversationId =
    str(message?.conversationId) ?? str(conversationBlock?.id) ?? str(asRecord(payload?.conversation)?.id)

  if (!providerConversationId) {
    // `conversation.started` always names one; anything else that does not is
    // a payload shape we do not know yet.
    return { handled: false }
  }

  const platform = str(message?.platform) ?? str(conversationBlock?.platform) ?? input.account?.platform ?? 'unknown'
  const accountId = await resolveAccountId(
    input.workspaceId,
    providerAccountId ?? str(asRecord(message?.account)?.accountId),
  )

  if (input.type === 'conversation.started' && !message) {
    const written = await upsertConversation({
      workspaceId: input.workspaceId,
      providerConversationId,
      platform,
      accountId,
      participant: asRecord(conversationBlock?.participant) ?? conversationBlock,
      status: conversationBlock?.status,
    })
    return written
      ? { handled: true, conversationId: written.id, created: written.created }
      : { handled: false }
  }

  if (!message) return { handled: false }

  const providerMessageId = str(message.id) ?? str(message.platformMessageId)
  if (!providerMessageId) return { handled: false }

  const direction = message.direction === 'outgoing' ? 'outgoing' : 'incoming'
  const sentAt = dateOrNull(message.sentAt) ?? dateOrNull(message.createdAt) ?? occurredAt
  const text = typeof message.text === 'string' ? message.text : (typeof message.message === 'string' ? message.message : null)

  const conversation = await upsertConversation({
    workspaceId: input.workspaceId,
    providerConversationId,
    platform,
    accountId,
    participant: asRecord(message.sender) ?? conversationBlock,
    status: conversationBlock?.status,
    lastMessageAt: sentAt,
    lastMessagePreview: preview(text),
  })
  if (!conversation) return { handled: false }

  const status =
    input.type === 'message.failed'
      ? 'failed'
      : input.type === 'message.read'
        ? 'read'
        : input.type === 'message.delivered'
          ? 'delivered'
          : 'sent'

  const written = await upsertMessage({
    workspaceId: input.workspaceId,
    conversationId: conversation.id,
    providerMessageId,
    direction,
    platform,
    text,
    attachments: message.attachments,
    author: asRecord(message.sender),
    status,
    error: str(asRecord(message.deliveryError)?.message) ?? str(message.error),
    sentAt,
  })
  if (!written) return { handled: false }

  // One new incoming message is one unread — and only once, however many times
  // the provider redelivers it.
  if (written.created && direction === 'incoming' && input.type === 'message.received') {
    await db.socialConversation.update({
      where: { id: conversation.id },
      data: { unreadCount: { increment: 1 } },
    })
  }
  // A reply from the connected account settles the thread.
  if (written.created && direction === 'outgoing') {
    await db.socialConversation.update({
      where: { id: conversation.id },
      data: { unreadCount: 0 },
    })
  }
  // `message.sent` is the provider telling us an outbound DM went out, whoever
  // sent it (our reply, the agent, the platform's own inbox). The meter claims
  // the row before it bills, so this and the reply path collapse onto one unit.
  if (direction === 'outgoing') {
    await meterOutboundMessage(input.workspaceId, written.id)
  }

  return { handled: true, conversationId: conversation.id, messageId: written.id, created: written.created }
}

// ── reading ───────────────────────────────────────────────────────────────

export interface ListConversationsInput {
  status?: string | null
  platform?: string | null
  unreadOnly?: boolean
  limit?: number
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

export async function listConversations(workspaceId: string, input: ListConversationsInput = {}) {
  const where: Record<string, unknown> = { workspaceId }
  if (input.status) where.status = input.status
  if (input.platform) where.platform = input.platform
  if (input.unreadOnly) where.unreadCount = { gt: 0 }
  return db.socialConversation.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    take: clampLimit(input.limit, 50, 100),
  })
}

export interface ConversationWindow {
  /** How many messages to return (default 100, max 200). */
  messageLimit?: number
  /**
   * Page backwards: return the messages older than this message id. The first
   * page of a thread is its *recent* end, because a chat view has to show the
   * message being answered, not message 1 of 400.
   */
  before?: string | null
}

export interface ConversationView {
  conversation: any
  /** Ascending by `sentAt`, so it renders top to bottom as-is. */
  messages: any[]
  /** True when there is older history above this window. */
  hasMore: boolean
  /** Pass as `before` to fetch the next older page. */
  nextCursor: string | null
}

export async function getConversation(
  workspaceId: string,
  conversationId: string,
  window: number | ConversationWindow = {},
): Promise<ConversationView> {
  const options: ConversationWindow = typeof window === 'number' ? { messageLimit: window } : window
  const limit = clampLimit(options.messageLimit, 100, 200)

  const conversation = await db.socialConversation.findFirst({
    where: { workspaceId, id: conversationId },
  })
  if (!conversation) throw new SocialError(404, 'conversation_not_found', 'No such conversation')

  const where: Record<string, unknown> = { workspaceId, conversationId: conversation.id }

  if (options.before) {
    const cursor = await db.socialMessage.findFirst({
      where: { workspaceId, conversationId: conversation.id, id: options.before },
      select: { id: true, sentAt: true },
    })
    if (!cursor) throw new SocialError(400, 'invalid_cursor', 'That message is not part of this thread')
    // Strictly older, with an id tiebreak so two messages sharing a timestamp
    // can never be returned twice or skipped.
    where.OR = [
      { sentAt: { lt: cursor.sentAt } },
      { sentAt: cursor.sentAt, id: { lt: cursor.id } },
    ]
  }

  const rows = await db.socialMessage.findMany({
    where,
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })
  const hasMore = rows.length > limit
  const messages = (hasMore ? rows.slice(0, limit) : rows).reverse()
  return {
    conversation,
    messages,
    hasMore,
    nextCursor: hasMore && messages.length > 0 ? messages[0].id : null,
  }
}

/**
 * Where a read marker belongs: the `sentAt` of the newest incoming message the
 * reader could actually have seen — not the wall clock.
 *
 * `reconcileUnreadCount` compares the marker against the provider's `sentAt`,
 * so a marker taken from our clock hides anything the provider *sent* before
 * the read but *delivered* after it (a delayed webhook, or a sweep after an
 * offline window) — the exact case the derived count exists to catch.
 * Incoming-only for the same reason: our own outgoing rows are written with our
 * clock, so anchoring on them would put the marker back at "now".
 */
async function readAnchor(workspaceId: string, conversationId: string): Promise<Date | null> {
  const newest = await db.socialMessage.findFirst({
    where: { workspaceId, conversationId, direction: 'incoming' },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: { sentAt: true },
  })
  return newest?.sentAt ?? null
}

/** Local read marker. The thread's provider-side unread is left to the app. */
export async function markConversationRead(workspaceId: string, conversationId: string) {
  const conversation = await db.socialConversation.findFirst({
    where: { workspaceId, id: conversationId },
    select: { id: true },
  })
  if (!conversation) throw new SocialError(404, 'conversation_not_found', 'No such conversation')
  const anchor = await readAnchor(workspaceId, conversation.id)
  return db.socialConversation.update({
    where: { id: conversation.id },
    data: { unreadCount: 0, ...(anchor ? { lastReadAt: anchor } : {}) },
  })
}

export interface ListCommentsInput {
  platform?: string | null
  status?: string | null
  limit?: number
  /** Include the account's own replies (the provider echoes them back). */
  includeOwn?: boolean
}

export async function listComments(workspaceId: string, input: ListCommentsInput = {}) {
  const where: Record<string, unknown> = { workspaceId }
  if (input.platform) where.platform = input.platform
  if (input.status) where.status = input.status
  if (!input.includeOwn) where.isOwn = false
  return db.socialComment.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    take: clampLimit(input.limit, 50, 100),
  })
}

export async function getComment(workspaceId: string, commentId: string) {
  const comment = await db.socialComment.findFirst({ where: { workspaceId, id: commentId } })
  if (!comment) throw new SocialError(404, 'comment_not_found', 'No such comment')
  return comment
}

export async function markCommentRead(workspaceId: string, commentId: string) {
  const comment = await getComment(workspaceId, commentId)
  if (comment.status !== 'new') return comment
  return db.socialComment.update({ where: { id: comment.id }, data: { status: 'read' } })
}

// ── sending ───────────────────────────────────────────────────────────────

/**
 * Deterministic per (workspace, target, body) **and per attempt slot**: a retry
 * after a lost response replays the provider's original answer, while a second,
 * deliberate copy of the same text is a different key and actually goes out.
 * The slot is how many copies of that exact reply we have already recorded for
 * the target — rows are only written on success, so a send that got no response
 * cannot advance it.
 */
function replyKey(prefix: string, workspaceId: string, id: string, text: string, slot: number): string {
  const body = Buffer.from(text).toString('base64url').slice(0, 80)
  return `${prefix}:${workspaceId}:${id}:${body}:${slot}`
}

export interface ReplyInput {
  text?: unknown
  idempotencyKey?: string | null
}

/**
 * Reply inside a DM thread. The provider answers `200` when it has *accepted*
 * the message; delivery status arrives later as `message.sent` /
 * `message.delivered` / `message.failed`, which land on the same row through
 * `ingestSocialEvent`.
 */
export async function replyToConversation(workspaceId: string, conversationId: string, input: ReplyInput) {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) throw new SocialError(400, 'empty_message', 'A reply needs text')
  if (text.length > 9_000) throw new SocialError(400, 'message_too_long', 'Keep a DM under 9,000 characters')

  const conversation = await db.socialConversation.findFirst({
    where: { workspaceId, id: conversationId },
  })
  if (!conversation) throw new SocialError(404, 'conversation_not_found', 'No such conversation')

  const account = conversation.accountId
    ? await db.socialAccount.findFirst({ where: { workspaceId, id: conversation.accountId } })
    : null
  if (!account) {
    throw new SocialError(
      409,
      'conversation_account_unknown',
      'This thread is not linked to a connected account yet. Run an inbox sync, then reply.',
    )
  }

  const slot = await db.socialMessage.count({
    where: { workspaceId, conversationId: conversation.id, direction: 'outgoing', text },
  })

  const result = await getSocialClient().request<any>({
    workspaceId,
    method: 'POST',
    path: `/inbox/conversations/${encodeURIComponent(conversation.zernioConversationId)}/messages`,
    body: { accountId: account.zernioAccountId, message: text },
    idempotencyKey: input.idempotencyKey?.trim() || replyKey('dm', workspaceId, conversation.id, text, slot),
  })

  const sent = asRecord(result?.data) ?? asRecord(result) ?? {}
  const providerMessageId =
    str(sent.messageId) ?? str(sent.id) ?? `local:${conversation.id}:${Date.now()}`

  const written = await upsertMessage({
    workspaceId,
    conversationId: conversation.id,
    providerMessageId,
    direction: 'outgoing',
    platform: conversation.platform,
    text,
    author: { name: account.displayName ?? account.username, username: account.username },
    status: 'sent',
    sentAt: new Date(),
  })

  const anchor = await readAnchor(workspaceId, conversation.id)
  await db.socialConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: preview(text),
      // Replying is reading: the unread marker moves with the reply, anchored
      // to the thread so a message delivered after this reply still counts.
      unreadCount: 0,
      ...(anchor ? { lastReadAt: anchor } : {}),
    },
  })

  // The send is billable now, not when the provider echoes `message.sent` — that
  // echo may never come for a thread the platform's own inbox is driving. Both
  // paths go through the same claim, so whichever lands second is a no-op.
  const meter = written ? await meterOutboundMessage(workspaceId, written.id) : null

  return {
    messageId: written?.id ?? null,
    providerMessageId,
    conversationId: conversation.id,
    metered: meter?.billed === true,
  }
}

/**
 * Reply to a comment — publicly, as the account that owns the post. Passing
 * `commentId` makes it a reply to that comment; without it the reply lands on
 * the post.
 */
export async function replyToComment(workspaceId: string, commentId: string, input: ReplyInput) {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) throw new SocialError(400, 'empty_message', 'A reply needs text')

  const comment = await getComment(workspaceId, commentId)
  if (comment.isOwn) {
    throw new SocialError(409, 'comment_is_own', 'That comment was written by the connected account')
  }

  // Answer from the account the comment arrived on. Guessing a same-platform
  // account would reply as a different brand's handle, which is worse than
  // telling the caller to sync first.
  const account = comment.accountId
    ? await db.socialAccount.findFirst({ where: { workspaceId, id: comment.accountId } })
    : null
  if (!account) {
    throw new SocialError(
      409,
      'comment_account_unknown',
      'This comment is not linked to a connected account yet. Run an inbox sync, then reply.',
    )
  }

  const slot = await db.socialComment.count({
    where: { workspaceId, zernioPostId: comment.zernioPostId, isOwn: true, text },
  })

  const result = await getSocialClient().request<any>({
    workspaceId,
    method: 'POST',
    path: `/inbox/comments/${encodeURIComponent(comment.zernioPostId)}`,
    body: { accountId: account.zernioAccountId, message: text, commentId: comment.zernioCommentId },
    idempotencyKey: input.idempotencyKey?.trim() || replyKey('comment', workspaceId, comment.id, text, slot),
  })

  const sent = asRecord(result?.data) ?? asRecord(result) ?? {}
  const providerReplyId = str(sent.commentId) ?? str(sent.id)
  const now = new Date()

  // Our own reply, so the thread shows it without waiting for the echo
  // webhook — and when that echo does arrive it lands on this same row.
  if (providerReplyId) {
    await upsertComment({
      workspaceId,
      detail: {
        id: providerReplyId,
        postId: comment.zernioPostId,
        platformPostId: comment.platformPostId,
        platform: comment.platform,
        text,
        createdTime: now.toISOString(),
        author: { id: account.zernioAccountId, username: account.username, isOwnAccount: true },
      },
      payload: null,
      providerAccountId: account.zernioAccountId,
      occurredAt: now,
    })
  }

  await db.socialComment.update({
    where: { id: comment.id },
    data: { status: 'replied', repliedAt: now },
  })

  return { commentId: comment.id, providerReplyId, repliedAt: now }
}

// ── backfill ──────────────────────────────────────────────────────────────

export interface BackfillResult {
  conversations: number
  messages: number
  posts: number
  comments: number
  /** Accounts the provider could not serve on this sweep (token problems). */
  failedAccounts: string[]
}

function listOf(payload: any, ...keys: string[]): any[] {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return Array.isArray(payload) ? payload : []
}

/**
 * Sweep the provider into our tables: conversations, their messages, the posts
 * that carry comments, and those comments.
 *
 * This is the documented recovery path for a missed webhook, and the only thing
 * that fills history the provider replays *without* firing webhooks (Meta's
 * pre-connect DM history). It is idempotent by construction — every write goes
 * through the same upserts the webhook path uses.
 */
export async function backfillInbox(workspaceId: string, options: { limit?: number } = {}): Promise<BackfillResult> {
  const profile = await ensureProfile(workspaceId, await workspaceName(workspaceId))
  const client = getSocialClient()
  const pageSize = clampLimit(options.limit, 50, 100)
  const result: BackfillResult = { conversations: 0, messages: 0, posts: 0, comments: 0, failedAccounts: [] }

  const conversations = await client.request<any>({
    workspaceId,
    method: 'GET',
    path: '/inbox/conversations',
    query: { profileId: profile.zernioProfileId, limit: pageSize },
  })

  for (const failed of listOf(conversations?.meta, 'failedAccounts')) {
    const id = str(failed?.accountId)
    if (id) result.failedAccounts.push(id)
  }

  for (const raw of listOf(conversations, 'data', 'conversations')) {
    const providerConversationId = str(raw?.id)
    if (!providerConversationId) continue
    const providerAccountId = str(raw?.accountId)
    const accountId = await resolveAccountId(workspaceId, providerAccountId)
    const written = await upsertConversation({
      workspaceId,
      providerConversationId,
      platform: str(raw?.platform) ?? 'unknown',
      accountId,
      participant: {
        id: raw?.participantId,
        name: raw?.participantName,
        picture: raw?.participantPicture,
      },
      status: raw?.status,
      lastMessageAt: dateOrNull(raw?.updatedTime),
      lastMessagePreview: preview(str(raw?.lastMessage)),
      unreadCount: typeof raw?.unreadCount === 'number' ? raw.unreadCount : null,
    })
    if (!written) continue
    result.conversations++

    if (!providerAccountId) continue
    let newIncoming = 0
    try {
      const page = await client.request<any>({
        workspaceId,
        method: 'GET',
        path: `/inbox/conversations/${encodeURIComponent(providerConversationId)}/messages`,
        query: { accountId: providerAccountId, limit: pageSize, sortOrder: 'desc' },
      })
      for (const message of listOf(page, 'messages', 'data')) {
        const providerMessageId = str(message?.id)
        if (!providerMessageId) continue
        const delivered = await upsertMessage({
          workspaceId,
          conversationId: written.id,
          providerMessageId,
          direction: message?.direction === 'outgoing' ? 'outgoing' : 'incoming',
          platform: str(message?.platform) ?? str(raw?.platform) ?? 'unknown',
          text: typeof message?.message === 'string' ? message.message : (typeof message?.text === 'string' ? message.text : null),
          attachments: message?.attachments,
          author: { id: message?.senderId, name: message?.senderName },
          status: str(message?.deliveryStatus) ?? 'sent',
          error: str(asRecord(message?.deliveryError)?.message),
          sentAt: dateOrNull(message?.createdAt) ?? dateOrNull(message?.sentAt) ?? new Date(),
        })
        if (delivered?.created) {
          result.messages++
          if (message?.direction !== 'outgoing') newIncoming++
        }
      }
      if (newIncoming > 0) await reconcileUnreadCount(workspaceId, written.id)
    } catch (err) {
      // One unreadable thread must not abandon the sweep.
      if (err instanceof SocialError && err.status === 401) throw err
    }
  }

  let posts: any
  try {
    posts = await client.request<any>({
      workspaceId,
      method: 'GET',
      path: '/inbox/comments',
      query: { profileId: profile.zernioProfileId, limit: pageSize },
    })
  } catch (err) {
    // Comment access is per-platform; a workspace with none connected should
    // still get its DMs.
    if (err instanceof SocialError && err.status === 401) throw err
    posts = null
  }

  for (const raw of listOf(posts, 'data', 'comments')) {
    const postId = str(raw?.id)
    const providerAccountId = str(raw?.accountId)
    if (!postId) continue
    result.posts++
    if (!providerAccountId) continue
    try {
      const page = await client.request<any>({
        workspaceId,
        method: 'GET',
        path: `/inbox/comments/${encodeURIComponent(postId)}`,
        query: { accountId: providerAccountId, limit: pageSize },
      })
      for (const comment of listOf(page, 'comments', 'data')) {
        const written = await upsertComment({
          workspaceId,
          detail: { ...comment, postId },
          payload: asRecord(page?.post) ? { post: page.post } : null,
          providerAccountId,
          occurredAt: new Date(),
        })
        if (written?.created) result.comments++
      }
    } catch (err) {
      if (err instanceof SocialError && err.status === 401) throw err
    }
  }

  return result
}

/**
 * Recompute a thread's unread badge from its own rows and the read marker.
 *
 * The webhook path increments instead — it is cheap and it knows exactly what
 * is new. A sweep is the only thing that finds messages we never saw (a desktop
 * that was offline, or history the provider backfills without firing a hook),
 * so it must *set* the count rather than add to it: two overlapping sweeps, or
 * a sweep over messages the webhook already counted, would otherwise inflate
 * the badge. `lastReadAt` is what makes the derived count possible.
 */
async function reconcileUnreadCount(workspaceId: string, conversationId: string): Promise<number> {
  const conversation = await db.socialConversation.findFirst({
    where: { workspaceId, id: conversationId },
    select: { lastReadAt: true },
  })
  if (!conversation) return 0
  const where: Record<string, unknown> = { workspaceId, conversationId, direction: 'incoming' }
  if (conversation.lastReadAt) where.sentAt = { gt: conversation.lastReadAt }
  const unreadCount = await db.socialMessage.count({ where })
  await db.socialConversation.update({ where: { id: conversationId }, data: { unreadCount } })
  return unreadCount
}

/** The workspace's display name, which a fresh profile is created with. */
async function workspaceName(workspaceId: string): Promise<string> {
  const row = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
  return row?.name ?? 'Shogo workspace'
}
