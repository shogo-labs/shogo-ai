// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { age, applyAgentMessage, applyMove, assigneeName, assigneeOptionId, assigneeOptions, columnBadges, issuesByItem, itemsByColumn, workingLabel } from '../board-layout'
import type { AgentStatus, ChatMessage, Mentionables } from '../team-chat-api'
import type { BoardColumn, BoardView, WorkItem } from '../work-boards-api'

function column(id: string, extra: Partial<BoardColumn> = {}): BoardColumn {
  return { id, name: id, position: 0, category: 'active', wipLimit: null, agentRef: null, slaHours: null, ...extra }
}

function card(id: string, columnId: string, position: number, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, key: id.toUpperCase(), number: 1, boardId: 'b', columnId, position, title: id, description: null, fields: {},
    priority: 'none', assigneeUserId: null, assigneeAgentRef: null, dueAt: null, conversationId: null, threadRootMessageId: null,
    source: 'manual', externalRef: null, historySummary: null, columnEnteredAt: '', lastActivityAt: '', completedAt: null,
    archivedAt: null, createdAt: '', ...extra,
  }
}

const board = { id: 'b', columns: [column('todo'), column('doing')] } as any
const items = [card('a', 'todo', 1), card('b', 'todo', 2), card('c', 'todo', 3), card('d', 'doing', 1)]

describe('itemsByColumn', () => {
  test('groups by column in position order and skips archived cards', () => {
    const grouped = itemsByColumn({ board, items: [card('z', 'todo', 0.5, { archivedAt: 'x' }), ...items.slice().reverse()] })
    expect(grouped.get('todo')!.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(grouped.get('doing')!.map((i) => i.id)).toEqual(['d'])
  })
})

describe('applyMove', () => {
  test('dropping on another column without an anchor goes to the bottom', () => {
    const result = applyMove(items, { itemId: 'a', columnId: 'doing', beforeId: null })!
    expect(result.request).toEqual({ column: 'doing' })
    expect(itemsByColumn({ board, items: result.items }).get('doing')!.map((i) => i.id)).toEqual(['d', 'a'])
  })

  test('dropping above a card lands between it and the one before', () => {
    const result = applyMove(items, { itemId: 'c', columnId: 'todo', beforeId: 'b' })!
    expect(result.request).toEqual({ column: 'todo', before: 'b' })
    expect(itemsByColumn({ board, items: result.items }).get('todo')!.map((i) => i.id)).toEqual(['a', 'c', 'b'])
  })

  test('dropping above the first card goes to the top', () => {
    const result = applyMove(items, { itemId: 'd', columnId: 'todo', beforeId: 'a' })!
    expect(itemsByColumn({ board, items: result.items }).get('todo')!.map((i) => i.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  test('a drop that keeps the order is a no-op', () => {
    expect(applyMove(items, { itemId: 'a', columnId: 'todo', beforeId: 'b' })).toBeNull()
    expect(applyMove(items, { itemId: 'c', columnId: 'todo', beforeId: null })).toBeNull()
    expect(applyMove(items, { itemId: 'a', columnId: 'todo', beforeId: 'a' })).toBeNull()
  })
})

describe('badges', () => {
  test('WIP state and SLA breaches per column', () => {
    const issues = [
      { type: 'sla_breach' as const, itemId: 'a', columnId: 'todo', detail: '' },
      { type: 'stale' as const, itemId: 'a', columnId: 'todo', detail: '' },
    ]
    expect(columnBadges(column('todo', { wipLimit: 2 }), 3, issues)).toEqual({ count: 3, wip: 'over', breaches: 1 })
    expect(columnBadges(column('todo', { wipLimit: 3 }), 3, [])).toEqual({ count: 3, wip: 'at', breaches: 0 })
    expect(columnBadges(column('todo'), 3, []).wip).toBeNull()
    expect(issuesByItem(issues).get('a')!.map((i) => i.type)).toEqual(['sla_breach', 'stale'])
  })
})

describe('assignees', () => {
  const mentionables: Mentionables = {
    people: [{ id: 'u1', name: 'Ada', email: 'ada@x', image: null, role: 'member' }],
    agents: [
      { key: 'ws', projectId: null, name: 'Shogo', description: null, image: null },
      { key: 'p:p1', projectId: 'p1', name: 'Support bot', description: null, image: null },
    ],
  }

  test('names people and agents', () => {
    expect(assigneeName({ assigneeUserId: 'u1', assigneeAgentRef: null }, mentionables)).toBe('Ada')
    expect(assigneeName({ assigneeUserId: null, assigneeAgentRef: 'project:p1' }, mentionables)).toBe('Support bot')
    expect(assigneeName({ assigneeUserId: null, assigneeAgentRef: 'workspace' }, mentionables)).toBe('Shogo')
    expect(assigneeName({ assigneeUserId: null, assigneeAgentRef: null }, mentionables)).toBeNull()
  })

  test('options round-trip to the selected id', () => {
    const options = assigneeOptions(mentionables)
    expect(options.map((o) => o.id)).toEqual(['none', 'u:u1', 'a:workspace', 'a:project:p1'])
    for (const option of options) expect(assigneeOptionId(option.patch)).toBe(option.id)
  })

  test('leaves out agents with Boards off', () => {
    const options = assigneeOptions({
      people: [],
      agents: [
        { key: 'p:p1', projectId: 'p1', name: 'Support', description: null, image: null, boards: true },
        { key: 'p:p2', projectId: 'p2', name: 'Docs bot', description: null, image: null, boards: false },
      ],
    })
    expect(options.map((o) => o.id)).toEqual(['none', 'a:project:p1'])
  })
})

describe('working agents', () => {
  const view = {
    board: { id: 'b', columns: [column('todo')] } as any,
    items: [card('a', 'todo', 1, { threadRootMessageId: 'root-a' }), card('b', 'todo', 2, { threadRootMessageId: 'root-b' })],
    health: { issues: [] },
  } as BoardView
  const reply = (id: string, agentStatus: AgentStatus, extra: Partial<Pick<ChatMessage, 'authorType' | 'threadRootId' | 'authorAgent'>> = {}) => ({
    id, authorType: 'agent' as const, threadRootId: 'root-a', agentStatus, authorAgent: { projectId: 'p1', name: 'Support bot' }, ...extra,
  })

  test('a running reply shows on its card and settles off it', () => {
    const started = applyAgentMessage(view, reply('m1', 'running'))!
    expect(started.items.find((i) => i.id === 'a')!.working).toEqual([{ messageId: 'm1', name: 'Support bot' }])
    expect(started.items.find((i) => i.id === 'b')!.working).toBeUndefined()

    const settled = applyAgentMessage(started, reply('m1', 'done'))!
    expect(settled.items.find((i) => i.id === 'a')!.working).toEqual([])
  })

  test('several running replies on one card are all listed', () => {
    const first = applyAgentMessage(view, reply('m1', 'running'))!
    const both = applyAgentMessage(first, reply('m2', 'running', { authorAgent: { projectId: 'p2', name: 'Billing bot' } }))!
    expect(both.items.find((i) => i.id === 'a')!.working!.map((w) => w.name)).toEqual(['Support bot', 'Billing bot'])
  })

  test('no change means no new view', () => {
    const started = applyAgentMessage(view, reply('m1', 'running'))!
    expect(applyAgentMessage(started, reply('m1', 'running'))).toBeNull()
    expect(applyAgentMessage(view, reply('m9', 'done'))).toBeNull()
  })

  test('messages that are not agent replies in a card thread are ignored', () => {
    expect(applyAgentMessage(view, reply('m1', 'running', { authorType: 'user' }))).toBeNull()
    expect(applyAgentMessage(view, reply('m1', 'running', { threadRootId: 'other-thread' }))).toBeNull()
    expect(applyAgentMessage(view, reply('m1', 'running', { threadRootId: null }))).toBeNull()
  })

  test('the label names one agent or counts several', () => {
    expect(workingLabel([{ messageId: 'm1', name: 'Billing Bot' }])).toBe('Billing Bot is working')
    expect(workingLabel([{ messageId: 'm1', name: 'A' }, { messageId: 'm2', name: 'B' }])).toBe('2 agents working')
  })
})

test('age', () => {
  const now = Date.parse('2026-01-10T00:00:00Z')
  expect(age('2026-01-09T23:30:00Z', now)).toBe('30m')
  expect(age('2026-01-09T19:00:00Z', now)).toBe('5h')
  expect(age('2026-01-06T00:00:00Z', now)).toBe('4d')
})
