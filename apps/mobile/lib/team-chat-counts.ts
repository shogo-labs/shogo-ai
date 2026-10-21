// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unread counts for the rail, dock and tab-title badges. Pure, so the rules
 * for thread replies and dots can be tested without the app's providers.
 */
import type { ConversationSummary } from './team-chat-api'

export interface TeamChatCounts {
  /** Mentions in channels. */
  channels: number
  /** Unread in direct messages, people and agents together. */
  dms: number
  /** Unread inbox items, not counting thread replies when those only show as a dot. */
  inbox: number
  /** Only unread thread replies, and the setting keeps them out of the number: show a dot instead. */
  activityDot: boolean
}

/** Unread inbox items in total, and how many of them are thread replies. */
export interface InboxUnread {
  unread: number
  unreadThreads: number
}

/**
 * Whether a conversation has something new to read — the one test behind a
 * row's bold title and behind the "Unreads" list alike, so those two views
 * of the same conversation can't disagree. Unlike the rail's mention-only
 * channel badge, this is true for *any* unread message, matching what makes
 * a Slack channel bold even with no mention in it.
 */
export function isConversationUnread(
  c: Pick<ConversationSummary, 'unreadCount' | 'muted' | 'joined' | 'archivedAt' | 'kind'>,
): boolean {
  const eligible = c.joined || c.kind === 'activity'
  return c.unreadCount > 0 && !c.muted && !c.archivedAt && eligible
}

/** Every joined, unmuted, unarchived conversation with something unread, in list order. */
export function unreadConversations(list: ConversationSummary[]): ConversationSummary[] {
  return list.filter(isConversationUnread)
}

export function countUnread(
  list: ConversationSummary[],
  inbox: InboxUnread,
  threadRepliesInBadge = true,
): TeamChatCounts {
  let channels = 0
  let dms = 0
  for (const c of list) {
    if (c.archivedAt || c.muted) continue
    if (c.kind === 'dm' || c.kind === 'group_dm') dms += c.unreadCount
    else channels += c.mentionCount
  }
  const threads = Math.min(inbox.unreadThreads, inbox.unread)
  const inboxNumber = threadRepliesInBadge ? inbox.unread : inbox.unread - threads
  const activityDot = !threadRepliesInBadge && inboxNumber === 0 && threads > 0
  return { channels, dms, inbox: inboxNumber, activityDot }
}
