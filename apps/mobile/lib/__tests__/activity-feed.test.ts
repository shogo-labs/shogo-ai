// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ActiveChatTurn, AgentTask } from '../api'
import type { InboxItem, SentMessage } from '../team-chat-api'
import { ACTIVITY_FILTERS, activityBadge, buildFeed, groupFeed, inboxEntry, matchesFilter, relativeTime, sectionFor, sentEntry, taskEntry, type ActivityEntry } from '../activity-feed'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function inbox(over: Partial<InboxItem> & Pick<InboxItem, 'id' | 'kind'>): InboxItem {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    threadRootId: null,
    actorUserId: 'u1',
    title: 'Eby',
    preview: 'hello',
    readAt: null,
    createdAt: ago(10),
    conversation: { id: 'c1', kind: 'dm', name: null, slug: null },
    ...over,
  }
}

function task(over: Partial<AgentTask> & Pick<AgentTask, 'id' | 'status'>): AgentTask {
  return {
    userId: 'u1',
    workspaceId: 'w1',
    projectId: 'p1',
    projectName: 'Billing',
    chatSessionId: 's1',
    title: 'Reconcile invoices',
    notes: null,
    dueAt: null,
    currentStep: null,
    resultSummary: null,
    errorMessage: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: ago(60),
    updatedAt: ago(30),
    ...over,
  }
}

const chat: ActiveChatTurn = {
  chatSessionId: 's9',
  turnId: 't9',
  sessionName: 'Plan the launch',
  isPrimary: false,
  projectId: null,
  projectName: null,
  projectHidden: false,
  startedAt: ago(2),
}

function sentMessage(over: Partial<SentMessage> & Pick<SentMessage, 'id'>): SentMessage {
  return {
    conversationId: 'c1',
    threadRootId: null,
    text: 'shipped it',
    createdAt: ago(10),
    conversation: { id: 'c1', kind: 'public', name: 'eng', slug: 'eng' },
    ...over,
  }
}

describe('inbox entries', () => {
  test('context reads like where it happened', () => {
    expect(inboxEntry(inbox({ id: '1', kind: 'dm' })).context).toBe('Direct Message')
    const channel = { id: 'c2', kind: 'public' as const, name: 'eng', slug: 'eng' }
    expect(inboxEntry(inbox({ id: '2', kind: 'thread', conversation: channel })).context).toBe('Thread in #eng')
    expect(inboxEntry(inbox({ id: '3', kind: 'mention', conversation: channel })).context).toBe('Mention in #eng')
    expect(inboxEntry(inbox({ id: '4', kind: 'reminder', conversation: null })).context).toBe('Reminder')
  })

  test('a reaction carries the emoji it used, not a generic one', () => {
    const channel = { id: 'c2', kind: 'public' as const, name: 'random', slug: 'random' }
    const title = (emoji: string) => `Eby Paul Daniel reacted ${emoji} to your message`
    expect(inboxEntry(inbox({ id: 'r1', kind: 'reaction', conversation: channel, title: title('🎉') })).emoji).toBe('🎉')
    expect(inboxEntry(inbox({ id: 'r2', kind: 'reaction', conversation: channel, title: title('❤️') })).emoji).toBe('❤️')
    expect(inboxEntry(inbox({ id: 'r3', kind: 'reaction', conversation: channel, title: title(':party_parrot:') })).emoji).toBe(':party_parrot:')
  })

  test('only reactions get an emoji, and an unreadable title falls back to none', () => {
    expect(inboxEntry(inbox({ id: 'm1', kind: 'mention', title: 'Ana reacted 🎉 to your message' })).emoji).toBeNull()
    expect(inboxEntry(inbox({ id: 'r4', kind: 'reaction', title: 'Eby' })).emoji).toBeNull()
  })

  test('a private channel is flagged so the row can show a lock', () => {
    const secret = { id: 'c3', kind: 'private' as const, name: 'team-cyberdyne', slug: null }
    const entry = inboxEntry(inbox({ id: '5', kind: 'thread', conversation: secret }))
    expect(entry.private).toBe(true)
    expect(entry.context).toBe('Thread in #team-cyberdyne')
  })

  test('read items are not unread', () => {
    expect(inboxEntry(inbox({ id: '6', kind: 'dm', readAt: ago(1) })).unread).toBe(false)
  })
})

describe('agent entries', () => {
  test('a failed task shows the readable error and asks for attention', () => {
    const entry = taskEntry(task({ id: 'a', status: 'failed', errorMessage: 'pod_unavailable' }), NOW)
    expect(entry.context).toBe('Agent task in Billing')
    expect(entry.preview).toBe('The agent environment could not start. Please try again in a moment.')
    expect(entry.unread).toBe(true)
    expect(entry.agent?.state).toBe('failed')
  })

  test('an old failure no longer asks for attention', () => {
    const old = task({ id: 'b', status: 'failed', updatedAt: ago(60 * 48) })
    expect(taskEntry(old, NOW).unread).toBe(false)
  })

  test('completed and running tasks never count as unread', () => {
    expect(taskEntry(task({ id: 'c', status: 'completed', resultSummary: 'Matched 41 of 41' }), NOW).unread).toBe(false)
    expect(taskEntry(task({ id: 'd', status: 'running' }), NOW).unread).toBe(false)
  })

  test('a running task previews its current step', () => {
    expect(taskEntry(task({ id: 'e', status: 'running', currentStep: 'Reading statements' }), NOW).preview).toBe('Reading statements')
  })
})

describe('buildFeed', () => {
  const channel = { id: 'c2', kind: 'public' as const, name: 'eng', slug: 'eng' }
  const input = {
    inbox: [
      inbox({ id: 'dm', kind: 'dm', createdAt: ago(5) }),
      inbox({ id: 'mention', kind: 'mention', conversation: channel, createdAt: ago(15) }),
      inbox({ id: 'thread', kind: 'thread', conversation: channel, createdAt: ago(25), readAt: ago(1) }),
    ],
    tasks: [
      task({ id: 'done', status: 'completed', updatedAt: ago(20) }),
      task({ id: 'failed', status: 'failed', updatedAt: ago(8) }),
      task({ id: 'run', status: 'running', updatedAt: ago(3) }),
    ],
    activeChats: [chat],
    sent: [
      sentMessage({ id: 's1', createdAt: ago(4) }),
      sentMessage({ id: 's2', createdAt: ago(30), threadRootId: 'root-1' }),
    ],
    now: NOW,
  }
  const ids = (f: ReturnType<typeof buildFeed>) => f.entries.map((e) => e.id)

  test('people and agents share one list, newest first', () => {
    expect(ids(buildFeed(input))).toEqual(['inbox:dm', 'task:failed', 'inbox:mention', 'task:done', 'inbox:thread'])
  })

  test('Sent swaps the list for what you sent, and is not mail', () => {
    const feed = buildFeed({ ...input, filter: 'sent' })
    expect(ids(feed)).toEqual(['sent:s1', 'sent:s2'])
    // Agent work is not something you sent, and Sent has no running strip.
    expect(feed.running).toEqual([])
    expect(ids(buildFeed({ ...input, filter: 'all' }))).not.toContain('sent:s1')
  })

  test('work in progress is pulled into its own strip, not mixed into history', () => {
    const feed = buildFeed(input)
    expect(feed.running.map((e) => e.id)).toEqual(['chat:s9:t9', 'task:run'])
    expect(ids(feed)).not.toContain('task:run')
  })

  test('each chip narrows the list', () => {
    expect(ids(buildFeed({ ...input, filter: 'dms' }))).toEqual(['inbox:dm'])
    expect(ids(buildFeed({ ...input, filter: 'mentions' }))).toEqual(['inbox:mention'])
    expect(ids(buildFeed({ ...input, filter: 'threads' }))).toEqual(['inbox:thread'])
    expect(ids(buildFeed({ ...input, filter: 'agents' }))).toEqual(['task:failed', 'task:done'])
  })

  test('the Agents chip keeps the running strip; people chips drop it', () => {
    expect(buildFeed({ ...input, filter: 'agents' }).running).toHaveLength(2)
    expect(buildFeed({ ...input, filter: 'dms' }).running).toHaveLength(0)
  })

  test('unread only covers both sources and hides running work', () => {
    const feed = buildFeed({ ...input, unreadOnly: true })
    expect(ids(feed)).toEqual(['inbox:dm', 'task:failed', 'inbox:mention'])
    expect(feed.running).toEqual([])
  })
})

describe('sent entries', () => {
  test('Sent is the last chip, after the inbound ones', () => {
    expect(ACTIVITY_FILTERS[ACTIVITY_FILTERS.length - 1]).toEqual({ id: 'sent', label: 'Sent' })
  })

  test('the conversation is the title; threads and DMs say where they went', () => {
    const channel = sentEntry(sentMessage({ id: 's1' }))
    expect(channel.title).toBe('#eng')
    expect(channel.context).toBe('#eng')

    const thread = sentEntry(sentMessage({ id: 's2', threadRootId: 'root-1' }))
    expect(thread.context).toBe('Thread in #eng')

    const dm = sentEntry(sentMessage({
      id: 's3',
      conversation: { id: 'c2', kind: 'dm', name: null, slug: null },
    }))
    expect(dm.title).toBe('Direct Message')
    expect(dm.context).toBe('Direct Message')
    expect(dm.private).toBe(false)
  })

  test('a private channel keeps its lock and nothing outbound is unread', () => {
    const entry = sentEntry(sentMessage({
      id: 's4',
      conversation: { id: 'c3', kind: 'private', name: 'team-cyberdyne', slug: null },
    }))
    expect(entry.private).toBe(true)
    expect(entry.title).toBe('#team-cyberdyne')
    expect(entry.unread).toBe(false)
    expect(entry.source).toBe('sent')
    expect(entry.sent?.id).toBe('s4')
  })

  test('All never shows what you sent; Sent shows nothing else', () => {
    const outbound = sentEntry(sentMessage({ id: 's5' }))
    expect(matchesFilter(outbound, 'all')).toBe(false)
    expect(matchesFilter(outbound, 'sent')).toBe(true)

    const inbound = inboxEntry(inbox({ id: 'i5', kind: 'mention' }))
    expect(matchesFilter(inbound, 'all')).toBe(true)
    expect(matchesFilter(inbound, 'sent')).toBe(false)
    expect(matchesFilter(taskEntry(task({ id: 'a5', status: 'completed' }), NOW), 'sent')).toBe(false)
  })
})

describe('activityBadge', () => {
  test('is inbox unread plus recent agent failures', () => {
    const tasks = [
      task({ id: '1', status: 'failed', updatedAt: ago(5) }),
      task({ id: '2', status: 'failed', updatedAt: ago(60 * 72) }),
      task({ id: '3', status: 'completed' }),
    ]
    expect(activityBadge(4, tasks, NOW)).toBe(5)
    expect(activityBadge(0, [], NOW)).toBe(0)
  })
})

describe('relativeTime', () => {
  test('is short enough for a row', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h')
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d')
    expect(relativeTime(0, NOW)).toBe('')
  })
})

describe('sectionFor', () => {
  /** Local-time day arithmetic, matching how the section is computed. */
  const dayAt = (daysAgo: number, hour = 12) => {
    const d = new Date(NOW)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }

  test('groups by calendar day, not by 24-hour blocks', () => {
    expect(sectionFor(dayAt(0, 13), NOW)).toBe('today')
    expect(sectionFor(dayAt(1), NOW)).toBe('yesterday')
    expect(sectionFor(dayAt(3), NOW)).toBe('earlier')
  })

  test('late yesterday and early today are different sections', () => {
    // 24 hours apart is not the point — crossing midnight is.
    expect(sectionFor(dayAt(1, 23), NOW)).toBe('yesterday')
    expect(sectionFor(dayAt(0, 1), NOW)).toBe('today')
  })

  test('an unparseable date falls back to the oldest section', () => {
    expect(sectionFor(0, NOW)).toBe('earlier')
  })
})

describe('groupFeed', () => {
  const dayAt = (daysAgo: number, hour = 12) => {
    const d = new Date(NOW)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  const entry = (id: string, at: number): ActivityEntry => ({
    id,
    source: 'inbox',
    kind: 'message',
    title: id,
    context: 'Direct Message',
    preview: '',
    at,
    unread: true,
  })

  test('puts a header before each section, newest first, with its count', () => {
    const rows = groupFeed(
      [entry('a', dayAt(0, 13)), entry('b', dayAt(0, 9)), entry('c', dayAt(1)), entry('d', dayAt(4))],
      NOW,
    )

    expect(rows.map((r) => (r.type === 'header' ? `${r.label}:${r.count}` : r.entry.id))).toEqual([
      'Today:2',
      'a',
      'b',
      'Yesterday:1',
      'c',
      'Earlier:1',
      'd',
    ])
  })

  test('omits sections that have nothing in them', () => {
    const rows = groupFeed([entry('a', dayAt(0, 13))], NOW)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ type: 'header', section: 'today', count: 1 })
  })

  test('keys are unique, so the list can recycle rows', () => {
    const rows = groupFeed([entry('a', dayAt(0, 13)), entry('b', dayAt(1))], NOW)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  test('an empty feed produces no rows at all', () => {
    expect(groupFeed([], NOW)).toEqual([])
  })
})
