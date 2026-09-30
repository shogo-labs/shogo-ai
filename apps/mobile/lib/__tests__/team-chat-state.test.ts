// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ConversationSummary, Mentionables } from '../team-chat-api'
import {
  decodeMentions,
  scheduleOptions,
  expiryFrom,
  searchSnippet,
  activeMentionQuery,
  addOptimistic,
  applyListEvent,
  applyTimelineEvent,
  emptyTimeline,
  encodeMentions,
  failOptimistic,
  filterCandidates,
  groupForSidebar,
  insertMention,
  lastConfirmedSeq,
  mentionCandidates,
  mentionNames,
  mergePage,
  renderMentions,
  startsGroup,
} from '../team-chat-state'

function msg(partial: Partial<ChatMessage> & { id: string; seq: number }): ChatMessage {
  return {
    conversationId: 'c1',
    workspaceId: 'w1',
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'user',
    author: { id: 'u1', name: 'Ana', image: null },
    authorUserId: 'u1',
    authorAgent: null,
    text: 'hi',
    blocks: null,
    clientMsgId: null,
    agentSessionId: null,
    agentStatus: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    ...partial,
  }
}

function conv(partial: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    workspaceId: 'w1', kind: 'public', name: partial.id, slug: partial.id, topic: null, lastSeq: 5,
    lastMessageAt: null, archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', joined: true, starred: false,
    muted: false, notifyLevel: 'all', lastReadSeq: 5, unreadCount: 0, mentionCount: 0,
    ...partial,
  }
}

const channel = { conversationId: 'c1', threadRootId: null }

describe('timeline', () => {
  test('channel view keeps top-level messages and thread replies sent to the channel', () => {
    let state = mergePage(emptyTimeline, { messages: [msg({ id: 'm1', seq: 1 })], hasMore: true }, 'initial')
    state = applyTimelineEvent(state, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'r1', seq: 2, threadRootId: 'm1' }) }, channel)
    state = applyTimelineEvent(state, {
      type: 'message.created', conversationId: 'c1', message: msg({ id: 'r2', seq: 3, threadRootId: 'm1', alsoSentToChannel: true }),
    }, channel)
    state = applyTimelineEvent(state, { type: 'message.updated', conversationId: 'c1', message: msg({ id: 'm1', seq: 1, replyCount: 2 }) }, channel)
    expect(state.messages.map((m) => m.id)).toEqual(['m1', 'r2'])
    expect(state.messages[0].replyCount).toBe(2)
    expect(state.hasMoreOlder).toBe(true)
  })

  test('new thread replies bump the root reply count live', () => {
    let state = mergePage(emptyTimeline, { messages: [msg({ id: 'm1', seq: 1 })], hasMore: false }, 'initial')
    const reply = msg({ id: 'r1', seq: 2, threadRootId: 'm1', createdAt: '2026-09-30T10:00:00.000Z' })
    state = applyTimelineEvent(state, { type: 'message.created', conversationId: 'c1', message: reply }, channel)
    state = applyTimelineEvent(state, { type: 'message.updated', conversationId: 'c1', message: { ...reply, text: 'edited' } }, channel)
    expect(state.messages.map((m) => m.id)).toEqual(['m1'])
    expect(state.messages[0].replyCount).toBe(1)
    expect(state.messages[0].lastReplyAt).toBe('2026-09-30T10:00:00.000Z')
  })

  test('thread view keeps the root and its replies', () => {
    const scope = { conversationId: 'c1', threadRootId: 'm1' }
    let state = mergePage(emptyTimeline, { root: msg({ id: 'm1', seq: 1 }), messages: [], hasMore: false }, 'initial')
    state = applyTimelineEvent(state, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'x', seq: 2 }) }, scope)
    state = applyTimelineEvent(state, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'r1', seq: 3, threadRootId: 'm1' }) }, scope)
    expect(state.messages.map((m) => m.id)).toEqual(['m1', 'r1'])
  })

  test('optimistic sends are replaced by the server copy and failures are marked', () => {
    let state = addOptimistic(emptyTimeline, msg({ id: 'tmp-1', seq: 0, clientMsgId: 'c-1' }))
    state = addOptimistic(state, msg({ id: 'tmp-2', seq: 0, clientMsgId: 'c-2' }))
    state = applyTimelineEvent(state, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'm9', seq: 9, clientMsgId: 'c-1' }) }, channel)
    state = failOptimistic(state, 'c-2')
    expect(state.messages.map((m) => [m.id, m.pending ?? null])).toEqual([['m9', null], ['tmp-2', 'failed']])
    expect(lastConfirmedSeq(state)).toBe(9)
  })

  test('agent deltas stream until the reply finishes; reactions update in place', () => {
    let state = mergePage(emptyTimeline, {
      messages: [msg({ id: 'a1', seq: 4, authorType: 'agent', agentStatus: 'running', text: '' })], hasMore: false,
    }, 'initial')
    state = applyTimelineEvent(state, { type: 'agent.delta', conversationId: 'c1', messageId: 'a1', text: 'Work', tool: 'query_db' }, channel)
    expect(state.streaming.a1).toEqual({ text: 'Work', tool: 'query_db' })
    state = applyTimelineEvent(state, { type: 'agent.delta', conversationId: 'c1', messageId: 'zzz', text: 'x', tool: null }, channel)
    expect(state.streaming.zzz).toBeUndefined()
    state = applyTimelineEvent(state, {
      type: 'message.updated', conversationId: 'c1', message: msg({ id: 'a1', seq: 4, authorType: 'agent', agentStatus: 'done', text: 'Done' }),
    }, channel)
    expect(state.streaming.a1).toBeUndefined()
    state = applyTimelineEvent(state, { type: 'reaction.changed', conversationId: 'c1', messageId: 'a1', reactions: [{ emoji: '👍', count: 1, userIds: ['u1'] }] }, channel)
    expect(state.messages[0].reactions[0].emoji).toBe('👍')
  })

  test('grouping breaks on author change, agents, threads and time gaps', () => {
    const a = msg({ id: 'a', seq: 1 })
    expect(startsGroup(undefined, a)).toBe(true)
    expect(startsGroup(a, msg({ id: 'b', seq: 2, createdAt: '2026-09-30T10:01:00.000Z' }))).toBe(false)
    expect(startsGroup(a, msg({ id: 'c', seq: 2, createdAt: '2026-09-30T10:10:00.000Z' }))).toBe(true)
    expect(startsGroup(a, msg({ id: 'd', seq: 2, authorUserId: 'u2' }))).toBe(true)
    expect(startsGroup({ ...a, replyCount: 1 }, msg({ id: 'e', seq: 2 }))).toBe(true)
  })
})

describe('conversation list', () => {
  test('messages from others bump unread and mentions; my own and the open conversation stay read', () => {
    const list = [conv({ id: 'c1' }), conv({ id: 'c2' })]
    let update = applyListEvent(list, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'm', seq: 6, authorUserId: 'u2', text: 'hey <@u:me>' }) }, 'me', null)
    expect(update.list[0]).toMatchObject({ unreadCount: 1, mentionCount: 1, lastSeq: 6 })
    update = applyListEvent(update.list, { type: 'message.created', conversationId: 'c2', message: msg({ id: 'n', seq: 6, conversationId: 'c2', authorUserId: 'u2' }) }, 'me', 'c2')
    expect(update.list[1]).toMatchObject({ unreadCount: 0, lastReadSeq: 6 })
    update = applyListEvent(update.list, { type: 'message.created', conversationId: 'c1', message: msg({ id: 'o', seq: 7, authorUserId: 'me' }) }, 'me', null)
    expect(update.list[0]).toMatchObject({ unreadCount: 0, mentionCount: 0, lastReadSeq: 7 })
    update = applyListEvent(update.list, {
      type: 'message.created', conversationId: 'c1', message: msg({ id: 'p', seq: 8, authorUserId: 'u2', threadRootId: 'o' }),
    }, 'me', null)
    expect(update.list[0]).toMatchObject({ unreadCount: 0, lastSeq: 8 })
  })

  test('read events for me clear badges; membership changes ask for a refetch', () => {
    const list = [conv({ id: 'c1', lastSeq: 10, lastReadSeq: 4, unreadCount: 6, mentionCount: 2 })]
    const read = applyListEvent(list, { type: 'read', conversationId: 'c1', userId: 'me', seq: 10 }, 'me', null)
    expect(read.list[0]).toMatchObject({ unreadCount: 0, mentionCount: 0 })
    expect(applyListEvent(list, { type: 'read', conversationId: 'c1', userId: 'other', seq: 10 }, 'me', null).list).toBe(list)
    expect(applyListEvent(list, { type: 'member.joined', conversationId: 'c1', userId: 'x' }, 'me', null).refetch).toBe(true)
    expect(applyListEvent(list, {
      type: 'message.created', conversationId: 'new', message: msg({ id: 'q', seq: 1, conversationId: 'new', authorUserId: 'u2' }),
    }, 'me', null).refetch).toBe(true)
  })

  test('sidebar groups starred, channels (activity last), people DMs and agent DMs', () => {
    const groups = groupForSidebar([
      conv({ id: 'activity', kind: 'activity', name: 'activity' }),
      conv({ id: 'zeta', name: 'zeta' }),
      conv({ id: 'alpha', name: 'alpha' }),
      conv({ id: 'unjoined', name: 'aaa', joined: false }),
      conv({ id: 'fav', name: 'fav', starred: true }),
      conv({ id: 'dm', kind: 'dm', name: null, participants: [{ type: 'user', id: 'u2', name: 'Bo', image: null }] }),
      conv({ id: 'agent', kind: 'dm', name: null, participants: [{ type: 'agent', projectId: null, name: 'Shogo' }] }),
      conv({ id: 'old', name: 'old', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(groups.starred.map((c) => c.id)).toEqual(['fav'])
    expect(groups.channels.map((c) => c.id)).toEqual(['alpha', 'zeta', 'activity'])
    expect(groups.directMessages.map((c) => c.id)).toEqual(['dm'])
    expect(groups.agents.map((c) => c.id)).toEqual(['agent'])
  })
})

describe('mentions', () => {
  const mentionables: Mentionables = {
    people: [
      { id: 'me', name: 'Me', email: 'me@x.com', image: null, role: 'member' },
      { id: 'u2', name: 'Ana Lopez', email: 'ana@x.com', image: null, role: 'member' },
      { id: 'u3', name: 'Ana', email: 'ana2@x.com', image: null, role: 'member' },
    ],
    agents: [
      { key: 'ws', projectId: null, name: 'Shogo', description: null, image: null },
      { key: 'p:p1', projectId: 'p1', name: 'Billing Bot', description: null, image: null },
    ],
  }

  test('detects the @query at the cursor', () => {
    expect(activeMentionQuery('hi @bil', 7)).toEqual({ start: 3, query: 'bil' })
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMentionQuery('mail a@b', 8)).toBeNull()
    expect(activeMentionQuery('done @x ', 8)).toBeNull()
  })

  test('candidates exclude me, rank prefix matches first, and insert display names', () => {
    const candidates = mentionCandidates(mentionables, 'me')
    expect(candidates.some((c) => c.display === 'Me')).toBe(false)
    expect(filterCandidates(candidates, 'bot').map((c) => c.display)).toEqual(['Billing Bot'])
    expect(filterCandidates(candidates, 'ana').map((c) => c.display)).toEqual(['Ana Lopez', 'Ana'])
    const billing = candidates.find((c) => c.display === 'Billing Bot')!
    expect(insertMention('ask @bil', { start: 4, query: 'bil' }, billing)).toEqual({ text: 'ask @Billing Bot ', cursor: 17 })
  })

  test('encodes picked names to tokens (longest names first) and renders them back', () => {
    const candidates = mentionCandidates(mentionables, 'me')
    const picked = candidates.filter((c) => ['Ana', 'Ana Lopez', 'Billing Bot'].includes(c.display))
    const wire = encodeMentions('@Ana Lopez and @Ana, ask @Billing Bot. email@Ana stays', picked)
    expect(wire).toBe('<@u:u2> and <@u:u3>, ask <@a:p:p1>. email@Ana stays')
    expect(renderMentions(`${wire} <!here> <@a:ws> <@u:gone>`, mentionNames(mentionables))).toBe(
      '**@Ana Lopez** and **@Ana**, ask **@Billing Bot**. email@Ana stays **@here** **@Shogo** **@someone**',
    )
  })
})

describe('searchSnippet', () => {
  const names = { users: new Map([['u1', 'Ada']]), agents: new Map() }

  test('highlights word-prefix matches and renders mentions', () => {
    expect(searchSnippet('<@u:u1> is shipping the Launch', ['ship', 'launch'], names)).toEqual([
      { text: '@Ada is ', match: false },
      { text: 'shipping', match: true },
      { text: ' the ', match: false },
      { text: 'Launch', match: true },
    ])
  })

  test('centers long text on the first match', () => {
    const text = `${'filler '.repeat(80)}the launch is friday ${'tail '.repeat(80)}`
    const segments = searchSnippet(text, ['launch'], names, 100)
    const joined = segments.map((s) => s.text).join('')
    expect(joined.startsWith('…')).toBe(true)
    expect(joined.endsWith('…')).toBe(true)
    expect(segments.some((s) => s.match && s.text === 'launch')).toBe(true)
  })

  test('without terms it is a truncated preview', () => {
    expect(searchSnippet('hello there', [], names)).toEqual([{ text: 'hello there', match: false }])
  })
})

describe('expiryFrom', () => {
  const now = new Date(2026, 5, 10, 14, 0, 0)
  test('minutes, end of today, 9am tomorrow, and never', () => {
    expect(expiryFrom(30, now)).toBe(new Date(2026, 5, 10, 14, 30, 0).toISOString())
    expect(expiryFrom('today', now)).toBe(new Date(2026, 5, 10, 23, 59, 59).toISOString())
    expect(expiryFrom('tomorrow', now)).toBe(new Date(2026, 5, 11, 9, 0, 0).toISOString())
    expect(expiryFrom(null, now)).toBeNull()
  })
})

describe('decodeMentions', () => {
  test('round-trips with encodeMentions and leaves unknown tokens alone', () => {
    const ada = { kind: 'user' as const, display: 'Ada Lovelace', token: '<@u:ada>' }
    const here = { kind: 'special' as const, display: 'here', token: '<!here>' }
    const wire = '<@u:ada> and <!here>: see <@u:ghost>'
    const { text, picked } = decodeMentions(wire, [ada, here])
    expect(text).toBe('@Ada Lovelace and @here: see <@u:ghost>')
    expect(encodeMentions(text, picked)).toBe(wire)
  })
})

describe('scheduleOptions', () => {
  test('offers Monday only when it is not tomorrow', () => {
    const wed = new Date(2026, 0, 14, 15, 0)
    expect(scheduleOptions(wed).map((o) => o.label)).toEqual(['In 30 minutes', 'In 1 hour', 'Tomorrow at 9:00 AM', 'Monday at 9:00 AM'])
    expect(scheduleOptions(wed)[3].at.getTime()).toBe(new Date(2026, 0, 19, 9, 0).getTime())
    const sun = new Date(2026, 0, 18, 15, 0)
    expect(scheduleOptions(sun).map((o) => o.label)).toHaveLength(3)
  })
})

describe('group mentions', () => {
  test('groups autocomplete by handle and render as @handle', () => {
    const m = {
      people: [],
      agents: [],
      groups: [{ id: 'g1', handle: 'design', name: 'Design', description: null, createdById: 'u', memberIds: ['a', 'b'] }],
    } as Mentionables
    const group = mentionCandidates(m, null).find((c) => c.kind === 'group')!
    expect(group).toMatchObject({ display: 'design', token: '<@g:g1>', subtitle: 'Design · 2 people' })
    expect(renderMentions('<@g:g1> and <@g:gone>', mentionNames(m))).toBe('**@design** and **@group**')
  })
})
