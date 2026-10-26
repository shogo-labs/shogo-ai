// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { matchesActivityFilter } from '../activity-channel-filters'
import { buildFeed, inboxEntry } from '../activity-feed'
import { activityTarget } from '../activity-target'
import { tabForPathname, isConversationPath } from '../sidebar-tab'
import type { InboxItem } from '../team-chat-api'
import { isAskedOf, questionOptions, questionRefsOf, questionsOf, type Question } from '../team-chat-kinds'

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q_1',
  to: { userIds: ['u1'], via: 'mention' },
  header: 'Alert destination',
  prompt: 'Where should alerts go?',
  interaction: 'choice',
  options: [{ label: 'Slack' }, { label: 'PagerDuty' }],
  status: 'open',
  source: 'inferred',
  ...over,
})

describe('question blocks', () => {
  test('reads valid questions and drops malformed ones', () => {
    const blocks = { questions: [question(), { id: 'q_2', prompt: 'x?', interaction: 'slider' }, null, { prompt: 'no id?' }] }
    expect(questionsOf({ blocks }).map((q) => q.id)).toEqual(['q_1'])
    expect(questionsOf({ blocks: null })).toEqual([])
    expect(questionsOf({ blocks: { questions: 'nope' } })).toEqual([])
  })

  test('reads refs to questions asked earlier', () => {
    const refs = questionRefsOf({ blocks: { questionRefs: [{ messageId: 'm1', questionId: 'q_1', header: 'H', prompt: 'P?' }, { messageId: 'm2' }] } })
    expect(refs).toEqual([{ messageId: 'm1', questionId: 'q_1', header: 'H', prompt: 'P?' }])
  })

  test('options by interaction', () => {
    expect(questionOptions(question()).map((o) => o.label)).toEqual(['Slack', 'PagerDuty'])
    expect(questionOptions(question({ interaction: 'confirm', options: undefined })).map((o) => o.label)).toEqual(['Approve', 'Not yet', 'Discuss'])
    expect(questionOptions(question({ interaction: 'text' }))).toEqual([])
  })

  test('who is asked', () => {
    expect(isAskedOf(question(), 'u1')).toBe(true)
    expect(isAskedOf(question(), 'u2')).toBe(false)
    expect(isAskedOf(question(), null)).toBe(false)
    expect(isAskedOf(question({ to: { userIds: [], anyone: true, via: 'channel' } }), 'u2')).toBe(true)
  })
})

describe('questions in activity', () => {
  test('the Questions chip matches every question line', () => {
    for (const kind of ['question.asked', 'question.answered', 'question.closed']) {
      expect(matchesActivityFilter({ blocks: { type: 'activity', kind } }, 'questions')).toBe(true)
    }
    expect(matchesActivityFilter({ blocks: { type: 'activity', kind: 'agent.message' } }, 'questions')).toBe(false)
  })

  test('a question line opens the asking message in its thread', () => {
    expect(activityTarget({ type: 'activity', kind: 'question.answered', conversationId: 'c1', messageId: 'm1', threadRootId: 'r1' })).toEqual({
      type: 'route',
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: 'c1', msg: 'm1', thread: 'r1' },
    })
  })

  test('question inbox items sit under the Questions filter of the Activity tab', () => {
    const item: InboxItem = {
      id: 'i1', kind: 'question', conversationId: 'c1', messageId: 'm1', threadRootId: null, actorUserId: null,
      title: 'Billing Bot asked you: Alert destination', preview: 'Where should alerts go?', readAt: null,
      createdAt: '2026-10-13T10:00:00.000Z', conversation: { id: 'c1', kind: 'public', name: 'ops', slug: 'ops' },
    }
    expect(inboxEntry(item).context).toBe('Question in #ops')
    const feed = buildFeed({ inbox: [item], tasks: [], activeChats: [], filter: 'questions' })
    expect(feed.entries.map((e) => e.id)).toEqual(['inbox:i1'])
    expect(buildFeed({ inbox: [item], tasks: [], activeChats: [], filter: 'mentions' }).entries).toEqual([])
  })

  test('the Questions page belongs to the Activity tab and is not a conversation', () => {
    expect(tabForPathname('/(app)/c/questions')).toBe('activity')
    expect(isConversationPath('/(app)/c/questions')).toBe(false)
  })
})
