// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Shared chat-session list fetch for the sidebar tree and the native project chats page. */

export const PROJECT_CHAT_PAGE_SIZE = 50

export type ProjectChatListItem = {
  id: string
  name: string
  inferredName: string
  createdAt: number
  activity: number
  isPinned: boolean
  isArchived: boolean
}

type ChatSessionApiItem = {
  id: string
  name?: unknown
  inferredName?: string
  createdAt?: string | number
  lastActiveAt?: string | number
  updatedAt?: string | number
  isPinned?: boolean
  isArchived?: boolean
}

type ChatSessionsClient = {
  get: <T>(url: string) => Promise<{ data?: T }>
}

export function projectChatLabel(session: {
  name?: string
  inferredName?: string
  createdAt?: number
}): string {
  const name = typeof session.name === 'string' ? session.name.trim() : ''
  if (name) return name
  if (session.inferredName) return session.inferredName
  const created = session.createdAt ? new Date(session.createdAt) : new Date()
  return `Chat · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export function normalizeProjectChatItems(items: ChatSessionApiItem[]): ProjectChatListItem[] {
  return items
    .map((s) => ({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : '',
      inferredName: s.inferredName ?? '',
      createdAt: s.createdAt ? new Date(s.createdAt).getTime() : 0,
      activity: new Date(s.lastActiveAt || s.updatedAt || s.createdAt || 0).getTime(),
      isPinned: !!s.isPinned,
      isArchived: !!s.isArchived,
    }))
    .sort((a, b) => b.activity - a.activity)
}

export function visibleProjectChatItems(sessions: ProjectChatListItem[]): ProjectChatListItem[] {
  return sessions
    .filter((s) => !s.isArchived)
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
}

export async function fetchProjectChatSessions(
  http: ChatSessionsClient,
  projectId: string,
  limit = PROJECT_CHAT_PAGE_SIZE,
): Promise<{ sessions: ProjectChatListItem[]; hasMore: boolean }> {
  const res = await http.get<{ ok: boolean; items?: ChatSessionApiItem[] }>(
    `/api/chat-sessions?contextId=${encodeURIComponent(projectId)}&limit=${limit}`,
  )
  const rawItems = res.data?.items
  const items = Array.isArray(rawItems) ? rawItems : []
  return {
    sessions: normalizeProjectChatItems(items),
    hasMore: items.length >= limit,
  }
}
