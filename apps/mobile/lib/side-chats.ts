// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Labels and ordering for a user's personal workspace-agent chats. */

export interface SideChatItem {
  id: string
  name?: string | null
  inferredName?: string | null
  lastActiveAt?: string
  createdAt?: string
  isPinned?: boolean
  isArchived?: boolean
}

export function sideChatLabel(session: SideChatItem): string {
  const name = session.name?.trim()
  if (name) return name
  if (session.inferredName?.trim()) return session.inferredName.trim()
  const created = session.createdAt ? new Date(session.createdAt) : new Date()
  return `Chat · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

const lastActive = (s: SideChatItem) => new Date(s.lastActiveAt || s.createdAt || 0).getTime()

/** Pinned chats first, then most recently active. */
export function sortSideChats<T extends SideChatItem>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) =>
    Number(!!b.isPinned) - Number(!!a.isPinned) || lastActive(b) - lastActive(a),
  )
}
