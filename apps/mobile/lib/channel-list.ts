// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Channels panel: joined channels (starred first, #activity last), and
 * archived channels kept out of the way under their own label so they can
 * still be found to read, unarchive or delete.
 */
import type { ConversationSummary } from './team-chat-api'

export const isChannel = (c: Pick<ConversationSummary, 'kind'>): boolean =>
  c.kind === 'public' || c.kind === 'private' || c.kind === 'activity'

const byName = (a: ConversationSummary, b: ConversationSummary) => {
  if (a.kind === 'activity' && b.kind !== 'activity') return 1
  if (b.kind === 'activity' && a.kind !== 'activity') return -1
  return (a.name ?? '').localeCompare(b.name ?? '')
}

const archivedAt = (c: ConversationSummary) => (c.archivedAt ? Date.parse(c.archivedAt) : 0)

export interface SidebarChannels {
  starred: ConversationSummary[]
  others: ConversationSummary[]
  /**
   * Every archived channel this person can see, joined or not (archiving
   * doesn't make a channel any less findable), most recently archived first.
   * DMs and #activity aren't channels you archive, so they stay out.
   */
  archived: ConversationSummary[]
}

export function sidebarChannels(list: ConversationSummary[]): SidebarChannels {
  const live = list.filter((c) => isChannel(c) && !c.archivedAt && (c.joined || c.kind === 'activity'))
  return {
    starred: live.filter((c) => c.starred).sort(byName),
    others: live.filter((c) => !c.starred).sort(byName),
    archived: list
      .filter((c) => (c.kind === 'public' || c.kind === 'private') && !!c.archivedAt)
      .sort((a, b) => archivedAt(b) - archivedAt(a) || byName(a, b)),
  }
}
