// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Labels and ordering for a personal workspace's side (non-primary) chats. */

export interface SideChatItem {
  id: string
  name?: string | null
  inferredName?: string | null
  lastActiveAt?: string
  createdAt?: string
}

export function sideChatLabel(session: SideChatItem): string {
  const name = session.name?.trim()
  if (name) return name
  if (session.inferredName?.trim()) return session.inferredName.trim()
  const created = session.createdAt ? new Date(session.createdAt) : new Date()
  return `Chat · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

const lastActive = (s: SideChatItem) => new Date(s.lastActiveAt || s.createdAt || 0).getTime()

/** Most recently active first. */
export function sortSideChats<T extends SideChatItem>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => lastActive(b) - lastActive(a))
}
