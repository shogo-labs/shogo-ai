// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ConversationSummary, Participant } from '../team-chat-api'
import { directConversations, filterDms, isAgentDm, recentContacts, splitStarredDms } from '../dm-list'

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
  test('direct conversations, newest first, without channels or archived', () => {
    expect(ids(directConversations(list))).toEqual(['reviewer', 'eby', 'group', 'muted'])
  })
})

describe('isAgentDm', () => {
  test('true when every participant is an agent', () => {
    expect(isAgentDm(convo({ id: 'x', participants: [agent('p1')] }))).toBe(true)
    expect(isAgentDm(convo({ id: 'x', participants: [person('a'), agent('p1')] }))).toBe(false)
    expect(isAgentDm(convo({ id: 'x', participants: [person('a')] }))).toBe(false)
  })
})

describe('filterDms', () => {
  test('People excludes agent-only conversations; Agents chip added in SHO-473', () => {
    // 'reviewer' has only an agent participant → excluded from People
    expect(ids(filterDms(list, 'people'))).toEqual(['eby', 'group', 'muted'])
  })

  test('Agents returns empty list (agent rows come from useRecentAgentChats, not conversations)', () => {
    expect(filterDms(list, 'agents')).toEqual([])
  })

  test('Unreads leaves out muted and agent-only conversations', () => {
    // 'muted' is muted and 'reviewer' is an agent-only row — neither is a person DM.
    expect(ids(filterDms(list, 'unreads'))).toEqual(['eby'])
  })

  test('All shows people DMs (agents rendered separately in panel)', () => {
    // 'reviewer' has only an agent participant → excluded; 'old' is archived → excluded
    expect(ids(filterDms(list, 'all'))).toEqual(['eby', 'group', 'muted'])
  })
})

describe('splitStarredDms', () => {
  const withStar = [
    convo({ id: 'eby', starred: true, lastMessageAt: '2026-10-01T10:00:00Z' }),
    convo({ id: 'reviewer', lastMessageAt: '2026-10-01T11:00:00Z', participants: [agent('p1')] }),
    convo({ id: 'ana', starred: true, lastMessageAt: '2026-10-01T12:00:00Z', participants: [person('ana')] }),
    convo({ id: 'sam', lastMessageAt: '2026-10-01T13:00:00Z', participants: [person('sam')] }),
    convo({ id: 'general', kind: 'public', name: 'general', participants: [] }),
  ]

  test('starred rows move out of the main list instead of repeating there', () => {
    const { starred, others } = splitStarredDms(withStar, 'all')
    expect(ids(starred)).toEqual(['ana', 'eby'])
    // 'reviewer' is agent-only, so it reaches neither group; 'sam' is an ordinary person DM.
    expect(ids(others)).toEqual(['sam'])
  })

  test('the active chip narrows both groups', () => {
    // 'reviewer' has only an agent participant → excluded from people filter
    expect(ids(splitStarredDms(withStar, 'people').starred)).toEqual(['ana', 'eby'])
    expect(ids(splitStarredDms(withStar, 'people').others)).toEqual(['sam'])
  })

  test('channels and archived conversations stay out of both groups', () => {
    const { starred, others } = splitStarredDms(
      [...withStar, convo({ id: 'chan', kind: 'private', name: 'private', participants: [], starred: true }), convo({ id: 'old', starred: true, archivedAt: '2026-10-02T00:00:00Z' })],
      'all',
    )
    expect(ids(starred)).toEqual(['ana', 'eby'])
    expect(ids(others)).toEqual(['sam'])
  })

  test('nothing starred leaves the main list whole', () => {
    const { starred, others } = splitStarredDms(list, 'all')
    expect(starred).toEqual([])
    // Same rows the All chip shows — the agent-only row is already filtered out.
    expect(ids(others)).toEqual(ids(filterDms(list, 'all')))
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
