// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The note-to-self conversation: a direct message whose only member is you.
 * The server marks your own participant row, and everything that names a
 * direct message has to keep you in the title there while still leaving you
 * out of a normal DM.
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationSummary, Participant } from '../team-chat-api'
import { conversationTitle, isSelfDm } from '../team-chat-api'
import { filterDms, recentContacts } from '../dm-list'
import { groupForSidebar } from '../team-chat-state'

const person = (id: string, self = false): Participant => ({ type: 'user', id, name: id, image: null, ...(self ? { self: true } : {}) })
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

const selfDm = convo({ id: 'self', lastMessageAt: null, participants: [person('eby', true)] })
const dm = convo({ id: 'ana', participants: [person('ana')] })
const group = convo({ id: 'group', kind: 'group_dm', participants: [person('ana'), person('ben')] })
const agentDm = convo({ id: 'bot', participants: [agent('p1')] })

describe('isSelfDm', () => {
  test('is the direct message whose only member is you', () => {
    expect(isSelfDm(selfDm)).toBe(true)
    expect(isSelfDm(dm)).toBe(false)
    expect(isSelfDm(group)).toBe(false)
    expect(isSelfDm(agentDm)).toBe(false)
  })
})

describe('conversationTitle', () => {
  test('says which row is you in a note-to-self', () => {
    expect(conversationTitle(selfDm)).toBe('eby (you)')
  })

  test('a normal direct message still names only the other person', () => {
    expect(conversationTitle(dm)).toBe('ana')
    expect(conversationTitle(group)).toBe('ana, ben')
    expect(conversationTitle(agentDm)).toBe('p1')
  })

  test('falls back when there is nobody to name', () => {
    expect(conversationTitle(convo({ id: 'bare', participants: [] }))).toBe('Direct message')
  })
})

describe('where a note-to-self lands in the sidebar', () => {
  test('among the direct messages, not with the agents', () => {
    const groups = groupForSidebar([selfDm, dm, agentDm])
    expect(groups.directMessages.map((c) => c.id)).toEqual(['ana', 'self'])
    expect(groups.agents.map((c) => c.id)).toEqual(['bot'])
  })

  test('it is never starred into the top group by accident, and filters include it', () => {
    expect(groupForSidebar([selfDm]).starred).toEqual([])
    // Newest first: the note has no messages yet, so it sits below a used DM.
    expect(filterDms([selfDm, dm], 'all').map((c) => c.id)).toEqual(['ana', 'self'])
    expect(filterDms([selfDm, dm], 'people').map((c) => c.id)).toEqual(['ana', 'self'])
  })

  test('your own face stays out of the recent-contacts strip', () => {
    // It reaches the list, but the strip above it is for people you message.
    expect(filterDms([selfDm, dm], 'all').some((c) => c.id === 'self')).toBe(true)
    expect(recentContacts([selfDm, dm]).map((c) => c.id)).toEqual(['ana'])
  })
})
