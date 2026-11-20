// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The DMs tab: conversations with people, newest first, with chips to narrow
 * it. Agents appear here as links to their chat histories (SHO-473); a chat
 * with an agent is a project/workspace chat session, not a DM conversation.
 */
import type { ConversationSummary } from './team-chat-api'
import { isSelfDm } from './team-chat-api'

export type DmFilter = 'all' | 'unreads' | 'people' | 'agents'

export const DM_FILTERS: Array<{ id: DmFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unreads', label: 'Unreads' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
]

export const isDirect = (c: Pick<ConversationSummary, 'kind'>): boolean => c.kind === 'dm' || c.kind === 'group_dm'

/** True when every participant in a DM is an agent (a migrated agent-DM row). */
export function isAgentDm(c: ConversationSummary): boolean {
  const p = c.participants ?? []
  return p.length > 0 && p.every((pp) => pp.type === 'agent')
}

const at = (c: ConversationSummary) => (c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0)

/** Every direct conversation, newest first. Archived ones are left out. */
export function directConversations(list: ConversationSummary[]): ConversationSummary[] {
  return list.filter((c) => isDirect(c) && !c.archivedAt).sort((a, b) => at(b) - at(a))
}

/** Person-only DMs (excludes agent-keyed conversations). */
function peopleDms(list: ConversationSummary[]): ConversationSummary[] {
  return directConversations(list).filter((c) => !isAgentDm(c))
}

export function filterDms(list: ConversationSummary[], filter: DmFilter): ConversationSummary[] {
  switch (filter) {
    case 'all':
      return peopleDms(list) // agents rendered separately in the panel
    case 'unreads':
      return peopleDms(list).filter((c) => !c.muted && c.unreadCount > 0)
    case 'people':
      return peopleDms(list)
    case 'agents':
      return [] // agents not stored as conversations; panel renders them from useRecentAgentChats
  }
}

/**
 * The DMs tab draws a "Starred" group above the rest, mirroring the channels
 * panel. Starred rows move out of the main list rather than repeating there,
 * and the active chip narrows both groups so a filter can't leave behind a
 * starred row it excludes.
 */
export function splitStarredDms(
  list: ConversationSummary[],
  filter: DmFilter,
): { starred: ConversationSummary[]; others: ConversationSummary[] } {
  const dms = filterDms(list, filter)
  return { starred: dms.filter((c) => c.starred), others: dms.filter((c) => !c.starred) }
}

/**
 * The strip of faces above the list: the most recent conversations, one
 * per person or agent. Group DMs have no single face, and a note-to-self
 * isn't a person to reach, so both stay out.
 */
export function recentContacts(list: ConversationSummary[], limit = 10): ConversationSummary[] {
  return directConversations(list)
    .filter((c) => c.kind === 'dm' && !isSelfDm(c) && (c.participants ?? []).length === 1)
    .slice(0, limit)
}
