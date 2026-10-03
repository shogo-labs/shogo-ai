// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ConversationSummary, Participant } from '../team-chat-api'
import { directConversations, filterDms, recentContacts } from '../dm-list'

const person = (id: string): Participant => ({ type: 'user', id, name: id, image: null })
const agent = (projectId: string): Participant => ({ type: 'agent', projectId, name: projectId })

function convo(over: Partial<ConversationSummary> & Pick<ConversationSummary, 'id'>): ConversationSummary {
  return {
    workspaceId: 'w1',
    kind: 'dm',
    name: null,
    slug: null,
    topic: null,
    lastSeq: 1,
    lastMessageAt: '2026-10-01T10:00:00Z',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    joined: true,
    starred: false,
    muted: false,
    notifyLevel: 'all',
    lastReadSeq: 0,
    unreadCount: 0,
    mentionCount: 0,
    participants: [person('eby')],
    ...over,
  }
}

const list = [
  convo({ id: 'eby', lastMessageAt: '2026-10-01T10:00:00Z', unreadCount: 6 }),
  convo({ id: 'reviewer', lastMessageAt: '2026-10-01T11:00:00Z', participants: [agent('p1')], unreadCount: 1 }),
  convo({ id: 'group', kind: 'group_dm', lastMessageAt: '2026-10-01T09:00:00Z', participants: [person('a'), person('b')] }),
  convo({ id: 'muted', lastMessageAt: '2026-10-01T08:00:00Z', unreadCount: 4, muted: true }),
  convo({ id: 'old', lastMessageAt: '2026-10-01T07:00:00Z', archivedAt: '2026-10-02T00:00:00Z' }),
  convo({ id: 'general', kind: 'public', name: 'general', participants: [] }),
]
const ids = (l: ConversationSummary[]) => l.map((c) => c.id)

describe('directConversations', () => {
  test('people and agents together, newest first, without channels or archived', () => {
    expect(ids(directConversations(list))).toEqual(['reviewer', 'eby', 'group', 'muted'])
  })
})

describe('filterDms', () => {
  test('People leaves out agents; Agents keeps only them', () => {
    expect(ids(filterDms(list, 'people'))).toEqual(['eby', 'group', 'muted'])
    expect(ids(filterDms(list, 'agents'))).toEqual(['reviewer'])
  })

  test('Unreads counts people and agents, but not muted conversations', () => {
    expect(ids(filterDms(list, 'unreads'))).toEqual(['reviewer', 'eby'])
  })

  test('All is the whole list', () => {
    expect(filterDms(list, 'all')).toEqual(directConversations(list))
  })
})

describe('recentContacts', () => {
  test('one face per person or agent, no group DMs', () => {
    expect(ids(recentContacts(list))).toEqual(['reviewer', 'eby', 'muted'])
  })

  test('respects the limit', () => {
    expect(recentContacts(list, 2)).toHaveLength(2)
  })
})
