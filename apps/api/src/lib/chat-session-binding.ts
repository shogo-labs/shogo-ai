// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bind a chat-session id to the route it arrives on (SEC-27).
 *
 * The chat routes take the session id from the client (`X-Chat-Session-Id` or
 * the body) and used it as-is: the durable history seed was loaded from that
 * session and the user's message was written into it. Passing another tenant's
 * session id to your own project's `/chat` therefore read their conversation
 * into your agent and appended your message to their chat.
 *
 * An id with no row yet is a new chat the client just minted, which is allowed.
 * An id with a row must belong to this project (project routes) or this
 * workspace (workspace routes), and must not be someone else's personal chat.
 */

import { prisma } from './prisma'

export type ChatSessionBindingScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; workspaceId: string }

export interface ChatSessionBindingRow {
  contextType?: string | null
  contextId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
}

export interface ChatSessionCaller {
  userId?: string | null
  via?: string | null
}

/** Pure decision: may this caller use this existing session on this route? */
export function chatSessionBelongsTo(
  row: ChatSessionBindingRow | null | undefined,
  scope: ChatSessionBindingScope,
  caller: ChatSessionCaller,
): boolean {
  if (!row) return true
  const inScope =
    scope.kind === 'project'
      ? row.contextId === scope.projectId
      : row.workspaceId === scope.workspaceId
  if (!inScope) return false
  // A runtime acting for the workspace (chat_handoff) may post into a member's
  // personal chat in its own workspace; a person or an API key may not post
  // into someone else's.
  if (caller.via === 'runtimeToken') return true
  if (row.createdByUserId && row.createdByUserId !== caller.userId) return false
  return true
}

/** Loads the session and applies {@link chatSessionBelongsTo}. */
export async function isChatSessionBound(
  sessionId: string,
  scope: ChatSessionBindingScope,
  caller: ChatSessionCaller,
  db: Pick<typeof prisma, 'chatSession'> = prisma,
): Promise<boolean> {
  const row = await db.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, contextId: true, workspaceId: true, createdByUserId: true },
  })
  return chatSessionBelongsTo(row, scope, caller)
}

export const CHAT_SESSION_NOT_FOUND = {
  error: { code: 'chat_session_not_found', message: 'Chat session not found' },
} as const
