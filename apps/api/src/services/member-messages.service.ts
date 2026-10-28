// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The records behind "what did this person send?" — an owner/admin export.
 *
 * `engagement-analytics.service.ts` answers with totals; this answers with the
 * messages themselves, full text and ids, so an admin can dig further. Two
 * sources, both authored by the person and never a reply:
 *
 *   team_chat   `ConversationMessage.authorType = 'user'` in any conversation
 *               of the workspace, private channels and DMs included (that is
 *               what an admin export means) — deleted messages excluded.
 *   agent_chat  `ChatMessage.role = 'user'` in a chat belonging to the
 *               workspace. `project_call` relays and wake notes are left out:
 *               they are not something the person typed.
 *
 * Paging is keyset on `(createdAt, id)` across both sources, so a burst of
 * same-millisecond rows can neither repeat nor vanish between pages.
 */

import { prisma } from '../lib/prisma'
import { PROJECT_CALL_MESSAGE_AGENT } from '@shogo/shared-runtime/project-call-chat'
import { classifyAudience, type MessageAudience } from '../lib/engagement-compute'

const db = prisma as any

export const MEMBER_MESSAGE_MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export interface MemberMessageMention {
  type: string
  id: string | null
  name: string | null
}

export interface MemberMessageItem {
  id: string
  source: 'team_chat' | 'agent_chat'
  audience: MessageAudience
  text: string
  createdAt: string
  conversation: { id: string; kind: string; name: string | null } | null
  threadRootId: string | null
  workItemKey: string | null
  chatSession: { id: string; name: string | null; projectId: string | null } | null
  mentions: MemberMessageMention[]
}

export interface MemberMessagePage {
  items: MemberMessageItem[]
  /** Pass back as `cursor` for the next page. Null when the export is exhausted. */
  nextCursor: string | null
  /** User prompts in a shared chat with no owner — nobody can be credited, so they are counted, not guessed. */
  unattributed: number
}

export interface MemberMessageQuery {
  since?: Date | null
  until?: Date | null
  audience?: MessageAudience | null
  source?: 'team_chat' | 'agent_chat' | null
  cursor?: string | null
  limit?: number
}

interface Cursor {
  createdAt: Date
  id: string
}

export function encodeCursor(item: { createdAt: string; id: string }): string {
  return `${item.createdAt}|${item.id}`
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null
  const split = raw.lastIndexOf('|')
  if (split <= 0) return null
  const createdAt = new Date(raw.slice(0, split))
  const id = raw.slice(split + 1)
  if (!id || Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id }
}

/** `(createdAt, id) < (cursor.createdAt, cursor.id)`, the ordering both queries share. */
function belowCursor(cursor: Cursor | null) {
  if (!cursor) return {}
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  }
}

function compareDesc(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime()
  if (byTime !== 0) return byTime
  return b.id.localeCompare(a.id)
}

const messageWindow = (q: MemberMessageQuery) => ({
  ...(q.since ? { gte: q.since } : {}),
  ...(q.until ? { lte: q.until } : {}),
})

/** Conversations and cards referenced by a page, resolved in one query each. */
async function describeTeamChatPage(workspaceId: string, rows: any[]) {
  if (rows.length === 0) return []

  const conversationIds = [...new Set(rows.map((r) => r.conversationId as string))]
  const threadRootIds = [
    ...new Set(rows.map((r) => r.threadRootId).filter((id: string | null): id is string => !!id)),
  ]

  const [conversations, threadRoots, dmMembers, cards, mentionUsers, mentionProjects] = await Promise.all([
    db.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, kind: true, name: true },
    }),
    threadRootIds.length
      ? db.conversationMessage.findMany({
          where: { id: { in: threadRootIds } },
          select: { id: true, authorType: true },
        })
      : Promise.resolve([]),
    db.conversationMember.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { conversationId: true, memberType: true, userId: true },
    }),
    db.workItem.findMany({
      where: {
        workspaceId,
        threadRootMessageId: { in: [...threadRootIds, ...rows.map((r) => r.id as string)] },
      },
      select: { key: true, threadRootMessageId: true },
    }),
    db.user.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => (r.mentions ?? []).map((m: any) => m.targetUserId)).filter(Boolean))] } },
      select: { id: true, name: true, email: true },
    }),
    db.project.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => (r.mentions ?? []).map((m: any) => m.projectId)).filter(Boolean))] } },
      select: { id: true, name: true },
    }),
  ])

  const conversationById = new Map<string, any>(conversations.map((c: any) => [c.id, c] as [string, any]))
  const rootAuthorType = new Map<string, string>(
    (threadRoots as any[]).map((r: any) => [r.id, r.authorType] as [string, string]),
  )
  const cardKeyByThread = new Map<string, string>(
    (cards as any[])
      .filter((c: any) => !!c.threadRootMessageId)
      .map((c: any) => [c.threadRootMessageId as string, c.key as string] as [string, string]),
  )
  const userName = new Map<string, string | null>(
    (mentionUsers as any[]).map((u: any) => [u.id, u.name || u.email] as [string, string | null]),
  )
  const projectName = new Map<string, string | null>(
    (mentionProjects as any[]).map((p: any) => [p.id, p.name] as [string, string | null]),
  )
  const membersByConversation = new Map<string, { memberType: string; userId: string | null }[]>()
  for (const m of dmMembers) {
    const list = membersByConversation.get(m.conversationId) ?? []
    list.push({ memberType: m.memberType, userId: m.userId })
    membersByConversation.set(m.conversationId, list)
  }

  return rows.map((row): MemberMessageItem => {
    const conversation = conversationById.get(row.conversationId) as any
    const kind: string = conversation?.kind ?? 'public'
    const otherMemberTypes = (membersByConversation.get(row.conversationId) ?? [])
      .filter((m) => !m.userId || m.userId !== row.authorUserId)
      .map((m) => m.memberType)
    const threadRootId: string | null = row.threadRootId ?? null
    const mentions: any[] = row.mentions ?? []

    return {
      id: row.id,
      source: 'team_chat',
      audience: classifyAudience({
        conversationKind: kind,
        hasPersonMention: mentions.some((m) => m.targetType === 'user' || m.targetType === 'group'),
        hasAgentMention: mentions.some((m) => m.targetType === 'agent'),
        otherMemberTypes,
        threadRootAuthorType: threadRootId ? rootAuthorType.get(threadRootId) ?? null : null,
      }),
      text: String(row.text ?? ''),
      createdAt: new Date(row.createdAt).toISOString(),
      conversation: conversation
        ? { id: conversation.id, kind: conversation.kind, name: conversation.name ?? null }
        : null,
      threadRootId,
      workItemKey: cardKeyByThread.get(threadRootId ?? row.id) ?? null,
      chatSession: null,
      mentions: mentions.map((m) => ({
        type: String(m.targetType),
        id: (m.targetUserId ?? m.projectId ?? null) as string | null,
        name: (m.targetUserId ? userName.get(m.targetUserId) : m.projectId ? projectName.get(m.projectId) : null) ?? null,
      })),
    }
  })
}

const TEAM_CHAT_SELECT = {
  id: true,
  authorUserId: true,
  createdAt: true,
  conversationId: true,
  threadRootId: true,
  text: true,
  mentions: { select: { targetType: true, targetUserId: true, projectId: true } },
}

/**
 * Every message this person *sent*, newest first, with the ids needed to dig
 * further. Replies, agent output and deleted messages are never included.
 */
export async function getMemberMessages(
  workspaceId: string,
  userId: string,
  query: MemberMessageQuery = {},
): Promise<MemberMessagePage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MEMBER_MESSAGE_MAX_LIMIT)
  const cursor = decodeCursor(query.cursor)
  const window = messageWindow(query)
  const wantsTeamChat = query.source !== 'agent_chat'
  const wantsAgentChat = query.source !== 'team_chat'
  const audience = query.audience ?? null

  const teamChatWhere = {
    workspaceId,
    authorType: 'user',
    authorUserId: userId,
    deletedAt: null,
    ...(Object.keys(window).length ? { createdAt: window } : {}),
    ...belowCursor(cursor),
  }
  const agentChatWhere = {
    role: 'user',
    agent: { not: PROJECT_CALL_MESSAGE_AGENT },
    ...(Object.keys(window).length ? { createdAt: window } : {}),
    ...belowCursor(cursor),
    AND: [
      {
        session: {
          OR: [{ workspaceId }, { project: { workspaceId } }],
        },
      },
      { OR: [{ authorUserId: userId }, { authorUserId: null, session: { createdByUserId: userId } }] },
    ],
  }

  // The audience filter is computed, not stored, so a filtered export reads in
  // rounds until it has enough matching rows rather than capping the page short.
  const rounds = audience ? 20 : 1
  const collected: MemberMessageItem[] = []
  let teamCursor = cursor
  let agentCursor = cursor
  // Team chat can hold any audience (a post to people, to an agent, both), so it
  // is read whatever the filter says. Agent-chat prompts are always to an agent.
  let teamDone = !wantsTeamChat
  let agentDone = !wantsAgentChat || (audience !== null && audience !== 'agent')

  for (let round = 0; round < rounds; round++) {
    if (collected.length > limit) break
    if (teamDone && agentDone) break
    const need = limit + 1 - collected.length

    const [teamRows, agentRows] = await Promise.all([
      teamDone
        ? Promise.resolve([])
        : db.conversationMessage.findMany({
            where: { ...teamChatWhere, ...belowCursor(teamCursor) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: need,
            select: TEAM_CHAT_SELECT,
          }),
      agentDone
        ? Promise.resolve([])
        : db.chatMessage.findMany({
            where: { ...agentChatWhere, ...belowCursor(agentCursor) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: need,
            select: {
              id: true,
              authorUserId: true,
              createdAt: true,
              content: true,
              sessionId: true,
              session: {
                select: {
                  id: true,
                  name: true,
                  inferredName: true,
                  createdByUserId: true,
                  contextType: true,
                  contextId: true,
                },
              },
            },
          }),
    ])

    const teamItems = (await describeTeamChatPage(workspaceId, teamRows)).filter(
      (item) => !audience || item.audience === audience,
    )
    const agentItems: MemberMessageItem[] = (agentRows as any[]).map((row) => ({
      id: row.id,
      source: 'agent_chat',
      audience: 'agent',
      text: String(row.content ?? ''),
      createdAt: new Date(row.createdAt).toISOString(),
      conversation: null,
      threadRootId: null,
      workItemKey: null,
      chatSession: row.session
        ? {
            id: row.session.id,
            name: row.session.name ?? row.session.inferredName ?? null,
            // ChatSession has no projectId: a project chat is contextType +
            // contextId (the FK on contextId), so the project is read from there.
            projectId: row.session.contextType === 'project' ? (row.session.contextId ?? null) : null,
          }
        : null,
      mentions: [],
    }))

    collected.push(...teamItems, ...agentItems)
    collected.sort((a, b) =>
      compareDesc({ createdAt: new Date(a.createdAt), id: a.id }, { createdAt: new Date(b.createdAt), id: b.id }),
    )

    // Advance each source past the last row this round actually read, so a
    // filtered-out row can never stall the loop.
    if (teamRows.length) {
      const last = teamRows[teamRows.length - 1]
      teamCursor = { createdAt: new Date(last.createdAt), id: last.id }
    }
    if (teamRows.length < need) teamDone = true
    if (agentRows.length) {
      const last = agentRows[agentRows.length - 1]
      agentCursor = { createdAt: new Date(last.createdAt), id: last.id }
    }
    if (agentRows.length < need) agentDone = true
  }

  const items = collected.slice(0, limit)
  const hasMore = collected.length > limit || !teamDone || !agentDone

  const unattributed =
    query.source === 'team_chat' || (audience !== null && audience !== 'agent')
      ? 0
      : await countUnattributedPrompts(workspaceId, window)

  return {
    items,
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : null,
    unattributed,
  }
}

/** User prompts in a chat whose sender is unknowable: no stamped author, no session owner. */
export async function countUnattributedPrompts(
  workspaceId: string,
  window: { gte?: Date; lte?: Date },
): Promise<number> {
  const filter = Object.keys(window).length ? { createdAt: window } : {}
  return db.chatMessage.count({
    where: {
      role: 'user',
      agent: { not: PROJECT_CALL_MESSAGE_AGENT },
      authorUserId: null,
      ...filter,
      AND: [
        { session: { OR: [{ workspaceId }, { project: { workspaceId } }] } },
        { session: { createdByUserId: null } },
      ],
    },
  })
}

/**
 * Every page, for the CSV. Bounded so one request cannot stream a whole
 * workspace's history.
 */
export async function getAllMemberMessages(
  workspaceId: string,
  userId: string,
  query: Omit<MemberMessageQuery, 'cursor' | 'limit'> = {},
  maxRows = 10000,
): Promise<{ items: MemberMessageItem[]; unattributed: number; truncated: boolean }> {
  const items: MemberMessageItem[] = []
  let cursor: string | null = null
  let unattributed = 0
  for (;;) {
    const page = await getMemberMessages(workspaceId, userId, {
      ...query,
      cursor,
      limit: MEMBER_MESSAGE_MAX_LIMIT,
    })
    items.push(...page.items)
    unattributed = page.unattributed
    cursor = page.nextCursor
    if (!cursor || items.length >= maxRows) {
      return { items: items.slice(0, maxRows), unattributed, truncated: !!cursor }
    }
  }
}
