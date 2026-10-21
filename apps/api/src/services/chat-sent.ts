// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The outbound half of the Activity panel: the team-chat messages *you* sent,
 * newest first. The inbox (`chat-inbox.ts`) only ever holds rows somebody else
 * created for you, so "Sent" reads the messages themselves.
 *
 * Scope is team chat only — channels, DMs and thread replies. Agent chats are
 * not messages a person sent in the team-chat sense and stay out.
 */

import { prisma } from '../lib/prisma'

const db = prisma as any

const PREVIEW_CHARS = 280

export interface SentMessagePage {
  before?: string | null
  beforeId?: string | null
  limit?: number
}

export function serializeSentMessage(row: any, conversation?: any) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId ?? null,
    text: String(row.text ?? '').slice(0, PREVIEW_CHARS),
    createdAt: new Date(row.createdAt).toISOString(),
    conversation: conversation
      ? { id: conversation.id, kind: conversation.kind, name: conversation.name ?? null, slug: conversation.slug ?? null }
      : null,
  }
}

/**
 * Your own messages, newest first, keyset-paginated on `(createdAt, id)` so a
 * burst of same-millisecond messages can neither repeat nor vanish between
 * pages.
 *
 * Only conversations the viewer can still open are read back: a message in a
 * private channel they have since left must not resurface, because tapping it
 * would be a 404.
 */
export async function listSentMessages(
  workspaceId: string,
  userId: string,
  opts: SentMessagePage = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const before = opts.before ? new Date(opts.before) : null
  const cursor = before && !Number.isNaN(before.getTime()) ? before : null
  const cursorId = cursor ? opts.beforeId ?? null : null

  const rows = await db.conversationMessage.findMany({
    where: {
      workspaceId,
      authorType: 'user',
      authorUserId: userId,
      deletedAt: null,
      conversation: {
        OR: [{ kind: { in: ['public', 'activity'] } }, { members: { some: { userId } } }],
      },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor } },
              // Without the id the tie is unresolvable; dropping the whole
              // millisecond is the only page boundary that cannot repeat a row.
              ...(cursorId ? [{ createdAt: cursor, id: { lt: cursorId } }] : []),
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, conversationId: true, threadRootId: true, text: true, createdAt: true },
  })

  const page = rows.slice(0, limit)
  const conversationIds = [...new Set(page.map((r: any) => r.conversationId))]
  const conversations = conversationIds.length
    ? await db.conversation.findMany({
        where: { id: { in: conversationIds } },
        select: { id: true, kind: true, name: true, slug: true },
      })
    : []
  const convById = new Map(conversations.map((c: any) => [c.id, c]))

  return {
    items: page.map((r: any) => serializeSentMessage(r, convById.get(r.conversationId))),
    hasMore: rows.length > limit,
  }
}
