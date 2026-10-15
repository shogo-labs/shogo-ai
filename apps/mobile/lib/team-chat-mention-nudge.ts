// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * After sending a channel message, flag anyone it mentions who isn't a
 * member of this conversation — same rule the server now uses to decide who
 * gets notified (see conversation-notifications.ts). The composer offers to
 * add them; see MentionNudgeCard.
 */

const MENTION_TOKEN_RE = /<@u:([^>]+)>/g

/** Every user id wire-mentioned in `text` (deduped, in first-seen order). */
export function extractMentionedUserIds(text: string): string[] {
  const ids = new Set<string>()
  for (const m of text.matchAll(MENTION_TOKEN_RE)) ids.add(m[1]!)
  return [...ids]
}

/** Mentioned user ids that are neither the author nor already in `memberUserIds`. */
export function nonMemberMentionIds(text: string, memberUserIds: Set<string>, authorId: string | null): string[] {
  return extractMentionedUserIds(text).filter((id) => id !== authorId && !memberUserIds.has(id))
}

/** "Ana", "Ana and Priya", or "Ana, Priya, and Sam". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}
