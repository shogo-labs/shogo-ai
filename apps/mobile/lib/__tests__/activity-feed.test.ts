// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ActiveChatTurn, AgentTask } from '../api'
import type { InboxItem } from '../team-chat-api'
import { activityBadge, buildFeed, inboxEntry, relativeTime, taskEntry } from '../activity-feed'

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

describe('inbox entries', () => {
  test('context reads like where it happened', () => {
    expect(inboxEntry(inbox({ id: '1', kind: 'dm' })).context).toBe('Direct Message')
    const channel = { id: 'c2', kind: 'public' as const, name: 'eng', slug: 'eng' }
    expect(inboxEntry(inbox({ id: '2', kind: 'thread', conversation: channel })).context).toBe('Thread in #eng')
    expect(inboxEntry(inbox({ id: '3', kind: 'mention', conversation: channel })).context).toBe('Mention in #eng')
    expect(inboxEntry(inbox({ id: '4', kind: 'reminder', conversation: null })).context).toBe('Reminder')
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
    now: NOW,
  }
  const ids = (f: ReturnType<typeof buildFeed>) => f.entries.map((e) => e.id)

  test('people and agents share one list, newest first', () => {
    expect(ids(buildFeed(input))).toEqual(['inbox:dm', 'task:failed', 'inbox:mention', 'task:done', 'inbox:thread'])
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
