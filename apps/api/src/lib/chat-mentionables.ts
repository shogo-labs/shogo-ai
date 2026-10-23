// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which chats a person may address from the composer's "@" menu, and the one
 * access check every other chat-tag path (context enrichment, delivery, the
 * agent's `chat_handoff` tool) reuses.
 *
 * A chat is openable when the requester created it, when its anchor project is
 * readable, or when it has no owner and lives in a workspace the requester is a
 * member of. Unowned chats in workspaces the person does not belong to stay
 * unreachable — that is the security boundary, not an oversight.
 *
 * The third clause is what makes local mode work at all: nothing on the
 * desktop/local path stamps an owner, and a project-anchored workspace chat is
 * written as `contextType: 'workspace'`, `contextId: <projectId>`,
 * `createdByUserId: null` — so without it `chat_handoff` 404s on every
 * workspace chat (SHO-118).
 *
 * The check is server-side on purpose: the picker is a convenience, never the
 * authorization.
 */

import { prisma } from './prisma'
import { accessibleProjectsWhere } from './authz'

export interface MentionableChat {
  id: string
  title: string
  contextType: string
  projectId: string | null
  projectName: string | null
  workspaceId: string
  workspaceName: string
  lastActiveAt: string
}

const TITLE_FALLBACK_CHARS = 100

/** A chat's display title: its name, else its inferred name, else `chat <id8>`. */
export function chatTitleOf(session: {
  id: string
  name?: string | null
  inferredName?: string | null
  lastMessageText?: string | null
}): string {
  const name = session.name?.replace(/\s+/g, ' ').trim()
  if (name) return name
  const inferred = session.inferredName?.replace(/\s+/g, ' ').trim()
  if (inferred) return inferred
  const last = session.lastMessageText?.replace(/\s+/g, ' ').trim()
  if (last) return last.slice(0, TITLE_FALLBACK_CHARS)
  return `chat ${session.id.slice(0, 8)}`
}

/** Project ids the person can read, across every workspace they belong to. */
export async function readableProjectIds(userId: string): Promise<string[]> {
  const where = await accessibleProjectsWhere({ userId, via: 'session' })
  const projects = await prisma.project.findMany({ where, select: { id: true } })
  return projects.map((project) => project.id)
}

/**
 * Workspace ids the person holds a workspace-level membership in (`projectId`
 * null). Same source `authz` reads, so an unowned chat is never openable in a
 * workspace the person cannot otherwise see.
 */
export async function memberWorkspaceIds(userId: string): Promise<string[]> {
  const rows = (await prisma.member.findMany({
    where: { userId, projectId: null },
    select: { workspaceId: true },
  })) as Array<{ workspaceId: string | null }>
  return [...new Set(rows.map((row) => row.workspaceId).filter((id): id is string => !!id))]
}

/**
 * Prisma filter selecting the chats `userId` may open. Workspace-agent chats
 * are per-person (their creator); project chats follow `project:read`; an
 * anchored or unowned workspace chat follows the shape the product creates.
 */
export async function chatAccessWhere(userId: string): Promise<Record<string, unknown>> {
  const [projectIds, workspaceIds] = await Promise.all([readableProjectIds(userId), memberWorkspaceIds(userId)])
  return {
    OR: [
      { contextType: 'workspace', createdByUserId: userId },
      ...(projectIds.length
        ? [
            // A project chat, and a workspace chat anchored on a project.
            { contextType: 'project', contextId: { in: projectIds } },
            { contextType: 'workspace', contextId: { in: projectIds } },
          ]
        : []),
      ...(workspaceIds.length
        ? [{ contextType: 'workspace', createdByUserId: null, workspaceId: { in: workspaceIds } }]
        : []),
    ],
  }
}

const SESSION_SELECT = {
  id: true,
  name: true,
  inferredName: true,
  contextType: true,
  contextId: true,
  workspaceId: true,
  isArchived: true,
  lastActiveAt: true,
  createdByUserId: true,
  activeTurnId: true,
  project: { select: { id: true, name: true, workspaceId: true, workspace: { select: { name: true } } } },
  workspace: { select: { id: true, name: true } },
} as const

type SessionRow = {
  id: string
  name: string | null
  inferredName: string | null
  contextType: string
  contextId: string | null
  workspaceId: string | null
  isArchived: boolean
  lastActiveAt: Date | string
  activeTurnId: string | null
  project: { id: string; name: string; workspaceId: string; workspace: { name: string } | null } | null
  workspace: { id: string; name: string } | null
}

/** `{ projectId, workspaceId, workspaceName }` for a session, whichever kind it is. */
export function chatScopeOf(session: SessionRow): {
  projectId: string | null
  projectName: string | null
  workspaceId: string
  workspaceName: string
} {
  if (session.project) {
    return {
      projectId: session.project.id,
      projectName: session.project.name,
      workspaceId: session.project.workspaceId,
      workspaceName: session.project.workspace?.name ?? '',
    }
  }
  return {
    projectId: null,
    projectName: null,
    workspaceId: session.workspaceId ?? session.workspace?.id ?? '',
    workspaceName: session.workspace?.name ?? '',
  }
}

/**
 * Chats the person can open, newest activity first. `ids` narrows to specific
 * chats (title lookups for rendered chips); `query` filters by title.
 */
export async function listChatMentionables(options: {
  userId: string
  query?: string
  limit?: number
  excludeSessionId?: string
  ids?: string[]
}): Promise<MentionableChat[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 12)))
  const ids = options.ids?.filter(Boolean).slice(0, 50)
  if (ids && ids.length === 0) return []

  const where: Record<string, unknown> = {
    AND: [
      await chatAccessWhere(options.userId),
      { isArchived: false },
      ...(ids ? [{ id: { in: ids } }] : []),
      ...(options.excludeSessionId ? [{ id: { not: options.excludeSessionId } }] : []),
    ],
  }

  const rows = (await prisma.chatSession.findMany({
    where,
    select: SESSION_SELECT,
    orderBy: { lastActiveAt: 'desc' },
    take: ids ? ids.length : limit,
  })) as unknown as SessionRow[]

  const query = options.query?.replace(/\s+/g, ' ').trim().toLowerCase()
  const mapped = rows.map((session) => {
    const scope = chatScopeOf(session)
    return {
      id: session.id,
      title: chatTitleOf(session),
      contextType: session.contextType,
      ...scope,
      lastActiveAt: new Date(session.lastActiveAt).toISOString(),
    }
  })
  const filtered = query ? mapped.filter((chat) => chat.title.toLowerCase().includes(query)) : mapped
  return ids ? filtered : filtered.slice(0, limit)
}

/** The session when `userId` may open it, else null. */
export async function resolveChatForUser(userId: string, chatId: string) {
  if (!chatId) return null
  const session = (await prisma.chatSession.findFirst({
    where: { AND: [{ id: chatId }, await chatAccessWhere(userId)] },
    select: SESSION_SELECT,
  })) as unknown as SessionRow | null
  if (!session || session.isArchived) return null
  return session
}

/** Same, accepting a title as well as an id (the agent's tool takes either). */
export async function resolveChatByRef(userId: string, ref: string) {
  const trimmed = ref.trim().replace(/^<@c:/, '').replace(/>$/, '')
  if (!trimmed) return null
  const byId = await resolveChatForUser(userId, trimmed)
  if (byId) return byId
  const candidates = await listChatMentionables({ userId, limit: 50 })
  const wanted = trimmed.toLowerCase()
  const match = candidates.find((chat) => chat.title.toLowerCase() === wanted)
  if (!match) return null
  return resolveChatForUser(userId, match.id)
}

/**
 * A bounded transcript of any chat the person can open, across workspaces.
 * Feeds the "@" chat reference: the runtime may not have the referenced chat's
 * workspace mounted, so the text travels with the turn.
 */
export async function readChatTranscript(
  userId: string,
  chatId: string,
  options: { limit?: number; maxBytes?: number } = {},
): Promise<{ id: string; title: string; projectId: string | null; messages: Array<{ role: string; text: string }>; truncated: boolean } | null> {
  const session = await resolveChatForUser(userId, chatId)
  if (!session) return null
  const limit = Math.max(1, Math.min(200, options.limit ?? 100))
  const maxBytes = Math.min(256 * 1024, Math.max(1024, options.maxBytes ?? 64 * 1024))
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId: chatId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { role: true, content: true },
  })
  const messages: Array<{ role: string; text: string }> = []
  let used = 0
  for (const row of rows) {
    const text = typeof row.content === 'string' ? row.content : ''
    if (!text) continue
    const clipped = text.slice(0, Math.max(0, maxBytes - used))
    messages.push({ role: row.role, text: clipped })
    used += clipped.length
    if (clipped.length < text.length) break
  }
  return {
    id: session.id,
    title: chatTitleOf(session),
    projectId: chatScopeOf(session).projectId,
    messages,
    truncated: used >= maxBytes || messages.length < rows.length,
  }
}
