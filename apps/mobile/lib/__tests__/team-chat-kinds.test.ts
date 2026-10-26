// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../team-chat-api'
import { approvalOf, cardProgress, connectRequestsOf, foldStatusRuns, isCollapsibleStatus, messageKind, statusCardOf, stepStates, workItemOf } from '../team-chat-kinds'

describe('connect requests', () => {
  test('reads the connect links an agent hit and drops malformed ones', () => {
    const github = { provider: 'github_app', connectUrl: 'https://github.com/apps/shogo/installations/new?state=s', message: 'Authorize it' }
    expect(connectRequestsOf({ blocks: { connect: [github, { provider: 'x', connectUrl: 'javascript:alert(1)' }, { connectUrl: 'https://a.test' }] } })).toEqual([github])
    expect(connectRequestsOf({ blocks: null })).toEqual([])
  })
})

function msg(id: number, partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${id}`, conversationId: 'c1', workspaceId: 'w1', seq: id, threadRootId: null, replyCount: 0, lastReplyAt: null,
    alsoSentToChannel: false, authorType: 'user', author: { id: 'u1', name: 'Ana', image: null }, authorUserId: 'u1',
    authorAgent: null, text: `message ${id}`, blocks: null, clientMsgId: null, agentSessionId: null, agentStatus: null,
    reactions: [], attachments: [], editedAt: null, deletedAt: null, createdAt: '2026-10-01T10:00:00.000Z', ...partial,
  }
}

const agent = (id: number, kind: string | null, extra: Partial<ChatMessage> = {}, projectId = 'builder') =>
  msg(id, {
    authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId, name: projectId }, agentStatus: 'done',
    blocks: kind ? { messageKind: kind } : null, ...extra,
  })

describe('kinds and cards', () => {
  test('reads the kind and rejects unknown ones', () => {
    expect(messageKind(agent(1, 'decision'))).toBe('decision')
    expect(messageKind(agent(1, 'urgent'))).toBeNull()
    expect(messageKind(msg(1))).toBeNull()
  })

  test('a status card needs the card block with a title', () => {
    const card = { title: 'Fix totals', status: 'working' as const, steps: ['Triage', 'Fix', 'Review'], step: 1 }
    expect(statusCardOf(agent(1, 'status', { blocks: { type: 'status_card', messageKind: 'status', card } }))).toEqual(card)
    expect(statusCardOf(agent(1, 'status', { blocks: { type: 'status_card', card: {} } }))).toBeNull()
    expect(statusCardOf(agent(1, 'status'))).toBeNull()
  })

  test('steps are done before the current one and pending after; done cards finish every step', () => {
    const card = { title: 't', status: 'working' as const, steps: ['a', 'b', 'c'], step: 1 }
    expect(stepStates(card)).toEqual(['done', 'current', 'pending'])
    expect(stepStates({ ...card, status: 'done' })).toEqual(['done', 'done', 'done'])
    expect(stepStates({ title: 't', status: 'working' })).toEqual([])
    expect(cardProgress(card)).toBeCloseTo(1 / 3)
    expect(cardProgress({ ...card, status: 'done' })).toBe(1)
    expect(cardProgress({ title: 't', status: 'working' })).toBe(0)
  })
})

describe('folding routine status posts', () => {
  test('only plain agent status posts fold', () => {
    expect(isCollapsibleStatus(agent(1, 'status'))).toBe(true)
    expect(isCollapsibleStatus(agent(1, 'result'))).toBe(false)
    expect(isCollapsibleStatus(agent(1, 'decision'))).toBe(false)
    expect(isCollapsibleStatus(agent(1, null))).toBe(false)
    expect(isCollapsibleStatus(msg(1, { blocks: { messageKind: 'status' } }))).toBe(false)
    expect(isCollapsibleStatus(agent(1, 'status', { agentStatus: 'running' }))).toBe(false)
    expect(isCollapsibleStatus(agent(1, 'status', { replyCount: 2 }))).toBe(false)
    expect(isCollapsibleStatus(agent(1, 'status', { blocks: { type: 'status_card', messageKind: 'status', card: { title: 'x', status: 'working' } } }))).toBe(false)
  })

  test('a run of two or more from one agent becomes one item showing the latest', () => {
    const items = foldStatusRuns([agent(1, 'status'), agent(2, 'status'), agent(3, 'status')])
    expect(items).toHaveLength(1)
    expect(items[0]!.message.id).toBe('m3')
    expect(items[0]!.folded.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('a single status post stays as it is', () => {
    const items = foldStatusRuns([msg(1), agent(2, 'status'), msg(3)])
    expect(items.map((i) => i.message.id)).toEqual(['m1', 'm2', 'm3'])
    expect(items.every((i) => i.folded.length === 0)).toBe(true)
  })

  test('runs break on another author, a different kind, or a different thread', () => {
    const items = foldStatusRuns([
      agent(1, 'status'), agent(2, 'status'),
      agent(3, 'status', {}, 'reviewer'), agent(4, 'status', {}, 'reviewer'),
      agent(5, 'status'), agent(6, 'result'), agent(7, 'status'),
      agent(8, 'status', { threadRootId: 'r1' }), agent(9, 'status', { threadRootId: 'r1' }), agent(10, 'status', { threadRootId: 'r2' }),
    ])
    expect(items.map((i) => [i.message.id, i.folded.length])).toEqual([
      ['m2', 1], ['m4', 1], ['m5', 0], ['m6', 0], ['m7', 0], ['m9', 1], ['m10', 0],
    ])
  })

  test('a person speaking in between ends the run', () => {
    const items = foldStatusRuns([agent(1, 'status'), agent(2, 'status'), msg(3), agent(4, 'status'), agent(5, 'status')])
    expect(items.map((i) => [i.message.id, i.folded.length])).toEqual([['m2', 1], ['m3', 0], ['m5', 1]])
  })
})

describe('workItemOf', () => {
  const block = {
    id: 'i1', key: 'SHO-17', boardId: 'b1', boardName: 'Shogo Dev', title: 'Board card renders as a card',
    column: { name: 'In Development', category: 'active' }, priority: 'high',
    assignee: { kind: 'agent', name: 'Shogo Dev 3' }, dueAt: null, path: '/work?card=i1',
  }

  test('reads the block a board card is posted with', () => {
    expect(workItemOf({ blocks: { type: 'status_card', workItem: block } })).toEqual(block)
  })

  test('legacy blocks posted without a title fall back to plain text', () => {
    expect(workItemOf({ blocks: { workItem: { id: 'i1', key: 'SHO-1', boardId: 'b1' } } })).toBeNull()
  })

  test('messages with no work item are left alone', () => {
    expect(workItemOf({ blocks: { type: 'status_card', card: { title: 't', status: 'done' } } })).toBeNull()
    expect(workItemOf({ blocks: null })).toBeNull()
  })
})

describe('approvalOf', () => {
  test('reads an approval request and ignores everything else', () => {
    const approval = { requestId: 'p1', toolName: 'github_merge_pr', summary: 'Merge #1', status: 'pending' }
    expect(approvalOf({ blocks: { type: 'approval_request', approval } })).toEqual(approval)
    expect(approvalOf({ blocks: { type: 'approval_request' } })).toBeNull()
    expect(approvalOf({ blocks: { type: 'status_card', card: { title: 't', status: 'done' } } })).toBeNull()
    expect(approvalOf({ blocks: null })).toBeNull()
  })
})
