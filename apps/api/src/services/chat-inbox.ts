// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The activity inbox: mentions, thread replies, keyword hits, reactions to
 * your messages, reminders, and questions agents asked you, each with its own
 * read state. A question's item is read once the question is closed.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'

const db = prisma as any

export type InboxKind = 'mention' | 'dm' | 'thread' | 'reaction' | 'reminder' | 'keyword' | 'broadcast' | 'message' | 'question'
const PREVIEW_CHARS = 280

export interface InboxItemInput {
  workspaceId: string
  userId: string
  kind: InboxKind
  conversationId?: string | null
  messageId?: string | null
  actorUserId?: string | null
  title: string
  preview: string
}

export function serializeInboxItem(row: any, conversation?: any) {
  return {
    id: row.id,
    kind: row.kind,
    conversationId: row.conversationId ?? null,
    messageId: row.messageId ?? null,
    threadRootId: row.threadRootId ?? null,
    actorUserId: row.actorUserId ?? null,
    title: row.title,
    preview: row.preview,
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    conversation: conversation
      ? { id: conversation.id, kind: conversation.kind, name: conversation.name ?? null, slug: conversation.slug ?? null }
      : null,
  }
}

export async function createInboxItems(items: InboxItemInput[]): Promise<void> {
  if (!items.length) return
  const rows = await Promise.all(items.map((item) =>
    db.chatInboxItem.create({
      data: { ...item, preview: item.preview.slice(0, PREVIEW_CHARS), title: item.title.slice(0, 200) },
    }).catch((err: unknown) => {
      console.warn('[chat-inbox] create failed:', (err as Error)?.message)
      return null
    }),
  ))
  for (const row of rows) {
    if (!row) continue
    publishConversationEvent(row.workspaceId, { type: 'inbox.created', item: serializeInboxItem(row) }, [row.userId])
  }
}

export async function unreadInboxCount(workspaceId: string, userId: string): Promise<number> {
  return db.chatInboxItem.count({ where: { workspaceId, userId, readAt: null } })
}

/**
 * Unread inbox items, with the thread replies among them. The client uses the
 * thread count to honor the "thread replies in the Activity badge" setting.
 */
export async function unreadInboxSnapshot(
  workspaceId: string,
  userId: string,
): Promise<{ unread: number; unreadThreads: number }> {
  const [unread, unreadThreads] = await Promise.all([
    unreadInboxCount(workspaceId, userId),
    db.chatInboxItem.count({ where: { workspaceId, userId, readAt: null, kind: 'thread' } }),
  ])
  return { unread, unreadThreads }
}

export async function listInbox(
  workspaceId: string,
  userId: string,
  opts: { unreadOnly?: boolean; before?: string | null; beforeId?: string | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const before = opts.before ? new Date(opts.before) : null
  const cursor = before && !Number.isNaN(before.getTime()) ? before : null
  const cursorId = cursor ? opts.beforeId ?? null : null
  const rows = await db.chatInboxItem.findMany({
    where: {
      workspaceId,
      userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor } },
              ...(cursorId ? [{ createdAt: cursor, id: { lt: cursorId } }] : []),
              // `createdAt` alone drops rows that share the boundary
              // millisecond — a batch mention writes several at once. The id
              // breaks the tie; without it the whole millisecond is skipped.

            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const conversationIds = [...new Set(page.map((r: any) => r.conversationId).filter(Boolean))]
  const messageIds = [...new Set(page.map((r: any) => r.messageId).filter(Boolean))]
  const [conversations, messages, snapshot] = await Promise.all([
    conversationIds.length
      ? db.conversation.findMany({ where: { id: { in: conversationIds } }, select: { id: true, kind: true, name: true, slug: true } })
      : [],
    messageIds.length
      ? db.conversationMessage.findMany({ where: { id: { in: messageIds } }, select: { id: true, threadRootId: true } })
      : [],
    unreadInboxSnapshot(workspaceId, userId),
  ])
  const convById = new Map(conversations.map((c: any) => [c.id, c]))
  const threadById = new Map(messages.map((m: any) => [m.id, m.threadRootId]))
  return {
    items: page.map((r: any) => serializeInboxItem(
      { ...r, threadRootId: r.messageId ? threadById.get(r.messageId) ?? null : null },
      r.conversationId ? convById.get(r.conversationId) : undefined,
    )),
    unread: snapshot.unread,
    unreadThreads: snapshot.unreadThreads,
    hasMore: rows.length > limit,
  }
}

export interface MarkInboxReadInput {
  ids?: string[]
  all?: boolean
  conversationId?: string
  threadRootId?: string
  unread?: boolean
}

/**
 * Mark items read (or unread with `unread: true`). Scoping to a conversation
 * only clears top-level items; thread items clear when the thread is opened.
 */
export async function markInboxRead(workspaceId: string, userId: string, input: MarkInboxReadInput): Promise<number> {
  const where: Record<string, unknown> = { workspaceId, userId }
  if (Array.isArray(input.ids) && input.ids.length) {
    where.id = { in: input.ids.slice(0, 500).map(String) }
  } else if (input.threadRootId) {
    const replies = await db.conversationMessage.findMany({
      where: { OR: [{ threadRootId: input.threadRootId }, { id: input.threadRootId }] },
      select: { id: true },
      take: 2000,
    })
    where.messageId = { in: replies.map((r: any) => r.id) }
  } else if (input.conversationId) {
    where.conversationId = input.conversationId
    where.kind = { not: 'thread' }
  } else if (!input.all) {
    return 0
  }
  const unread = input.unread === true
  where.readAt = unread ? { not: null } : null
  const { count } = await db.chatInboxItem.updateMany({ where, data: { readAt: unread ? null : new Date() } })
  if (count) {
    publishConversationEvent(workspaceId, { type: 'inbox.read', ...(await unreadInboxSnapshot(workspaceId, userId)) }, [userId])
  }
  return count
}
