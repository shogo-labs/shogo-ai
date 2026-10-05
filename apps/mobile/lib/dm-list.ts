// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The DMs tab: conversations with people and with agents in one list, newest
 * first, with chips to narrow it.
 */
import type { ConversationSummary } from './team-chat-api'

export type DmFilter = 'all' | 'unreads' | 'people' | 'agents'

export const DM_FILTERS: Array<{ id: DmFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unreads', label: 'Unreads' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
]

export const isDirect = (c: Pick<ConversationSummary, 'kind'>): boolean => c.kind === 'dm' || c.kind === 'group_dm'

export const isAgentDm = (c: Pick<ConversationSummary, 'participants'>): boolean => (c.participants ?? []).some((p) => p.type === 'agent')

const at = (c: ConversationSummary) => (c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0)

/** Every direct conversation, newest first. Archived ones are left out. */
export function directConversations(list: ConversationSummary[]): ConversationSummary[] {
  return list.filter((c) => isDirect(c) && !c.archivedAt).sort((a, b) => at(b) - at(a))
}

export function filterDms(list: ConversationSummary[], filter: DmFilter): ConversationSummary[] {
  const dms = directConversations(list)
  switch (filter) {
    case 'all':
      return dms
    case 'unreads':
      return dms.filter((c) => !c.muted && c.unreadCount > 0)
    case 'people':
      return dms.filter((c) => !isAgentDm(c))
    case 'agents':
      return dms.filter(isAgentDm)
  }
}

/**
 * The strip of faces above the list: the most recent conversations, one
 * per person or agent. Group DMs have no single face, so they stay out.
 */
export function recentContacts(list: ConversationSummary[], limit = 10): ConversationSummary[] {
  return directConversations(list)
    .filter((c) => c.kind === 'dm' && (c.participants ?? []).length === 1)
    .slice(0, limit)
}
