// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ConversationSummary } from '../team-chat-api'
import { sidebarChannels } from '../channel-list'

function convo(over: Partial<ConversationSummary> & Pick<ConversationSummary, 'id'>): ConversationSummary {
  return {
    workspaceId: 'w1',
    kind: 'public',
    name: over.id,
    slug: over.id,
    topic: null,
    lastSeq: 1,
    lastMessageAt: null,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    joined: true,
    starred: false,
    muted: false,
    notifyLevel: 'all',
    lastReadSeq: 1,
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  } as ConversationSummary
}

const ids = (list: ConversationSummary[]) => list.map((c) => c.id)

describe('sidebarChannels', () => {
  test('archived channels leave the channel list and get their own group', () => {
    const { starred, others, archived } = sidebarChannels([
      convo({ id: 'eng' }),
      convo({ id: 'old-launch', archivedAt: '2026-10-01T00:00:00Z' }),
      convo({ id: 'design', starred: true }),
      convo({ id: 'old-starred', starred: true, archivedAt: '2026-10-02T00:00:00Z' }),
    ])
    expect(ids(starred)).toEqual(['design'])
    expect(ids(others)).toEqual(['eng'])
    expect(ids(archived)).toEqual(['old-starred', 'old-launch'])
  })

  test('archived channels show whether or not you joined them, private ones included', () => {
    const { archived } = sidebarChannels([
      convo({ id: 'never-joined', joined: false, archivedAt: '2026-10-01T00:00:00Z' }),
      convo({ id: 'secret', kind: 'private', archivedAt: '2026-10-03T00:00:00Z' }),
      convo({ id: 'browsable', joined: false }),
    ])
    expect(ids(archived)).toEqual(['secret', 'never-joined'])
  })

  test('archived DMs and #activity are not channels you archive, so they stay out', () => {
    const { archived } = sidebarChannels([
      convo({ id: 'agent-dm', kind: 'dm', name: null, archivedAt: '2026-10-01T00:00:00Z' }),
      convo({ id: 'group', kind: 'group_dm', name: null, archivedAt: '2026-10-01T00:00:00Z' }),
      convo({ id: 'activity', kind: 'activity', archivedAt: '2026-10-01T00:00:00Z' }),
    ])
    expect(archived).toEqual([])
  })

  test('most recently archived first, then by name', () => {
    const { archived } = sidebarChannels([
      convo({ id: 'b-same', archivedAt: '2026-10-01T00:00:00Z' }),
      convo({ id: 'newest', archivedAt: '2026-10-05T00:00:00Z' }),
      convo({ id: 'a-same', archivedAt: '2026-10-01T00:00:00Z' }),
    ])
    expect(ids(archived)).toEqual(['newest', 'a-same', 'b-same'])
  })

  test('the live list is unchanged: joined channels by name, #activity last', () => {
    const { others } = sidebarChannels([
      convo({ id: 'activity', kind: 'activity', name: 'activity', joined: false }),
      convo({ id: 'zeta' }),
      convo({ id: 'alpha' }),
      convo({ id: 'not-joined', joined: false }),
    ])
    expect(ids(others)).toEqual(['alpha', 'zeta', 'activity'])
  })
})
