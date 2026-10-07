// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildAgentRows, sortByUrgency, stateLabel, urgencyRank, WORKSPACE_AGENT_KEY } from '../agent-urgency'
import type { PendingApproval } from '../team-chat-api'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const agent = (projectId: string | null, name = projectId ?? 'Workspace') => ({ key: projectId ?? 'ws', projectId, name })

const task = (id: string, projectId: string | null, status: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    projectId,
    status,
    title: `Task ${id}`,
    currentStep: null,
    resultSummary: null,
    errorMessage: null,
    chatSessionId: `s-${id}`,
    startedAt: iso(10),
    completedAt: null,
    updatedAt: iso(5),
    createdAt: iso(20),
    ...over,
  }) as any

const approval = (projectId: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
  messageId: `m-${projectId}`,
  conversationId: 'c1',
  requestId: `r-${projectId}`,
  projectId,
  agentName: projectId,
  toolName: 'exec',
  summary: 'Run a command: ls',
  createdAt: iso(1),
  ...over,
})

describe('sortByUrgency', () => {
  test('orders by state, then newest first', () => {
    const sorted = sortByUrgency([
      { id: 'a', state: 'done' as const, at: 5 },
      { id: 'b', state: 'running' as const, at: 1 },
      { id: 'c', state: 'needs_you' as const, at: 1 },
      { id: 'd', state: 'running' as const, at: 9 },
      { id: 'e', state: 'failed' as const, at: 3 },
      { id: 'f', state: 'queued' as const, at: 3 },
    ])
    expect(sorted.map((r) => r.id)).toEqual(['c', 'e', 'd', 'b', 'f', 'a'])
  })

  test('does not mutate its input', () => {
    const input = [
      { state: 'done' as const, at: 1 },
      { state: 'needs_you' as const, at: 1 },
    ]
    sortByUrgency(input)
    expect(input[0].state).toBe('done')
  })

  test('ranks match the documented order', () => {
    expect(urgencyRank('needs_you')).toBeLessThan(urgencyRank('failed'))
    expect(urgencyRank('failed')).toBeLessThan(urgencyRank('running'))
    expect(urgencyRank('running')).toBeLessThan(urgencyRank('queued'))
    expect(urgencyRank('queued')).toBeLessThan(urgencyRank('done'))
  })
})

describe('buildAgentRows', () => {
  test('a pending approval puts its agent first, with the command as detail', () => {
    const rows = buildAgentRows({
      agents: [agent('p1'), agent('p2')],
      tasks: [task('t1', 'p1', 'running'), task('t2', 'p2', 'running')],
      activeChats: [],
      approvals: [approval('p2')],
      now: NOW,
    })
    expect(rows.map((r) => r.key)).toEqual(['p2', 'p1'])
    expect(rows[0].state).toBe('needs_you')
    expect(rows[0].detail).toBe('Run a command: ls')
    expect(rows[0].approval?.messageId).toBe('m-p2')
  })

  test('shows the running step, falling back to the title', () => {
    const rows = buildAgentRows({
      agents: [agent('p1'), agent('p2')],
      tasks: [task('t1', 'p1', 'running', { currentStep: 'Reading invoices' }), task('t2', 'p2', 'running')],
      activeChats: [],
      approvals: [],
      now: NOW,
    })
    expect(rows.find((r) => r.key === 'p1')?.detail).toBe('Reading invoices')
    expect(rows.find((r) => r.key === 'p2')?.detail).toBe('Task t2')
  })

  test('an agent answering a chat counts as working', () => {
    const rows = buildAgentRows({
      agents: [agent('p1')],
      tasks: [],
      activeChats: [{ projectId: 'p1', sessionName: 'Fix login', startedAt: iso(2), chatSessionId: 's9' } as any],
      approvals: [],
      now: NOW,
    })
    expect(rows[0]).toMatchObject({ state: 'running', detail: 'Fix login', chatSessionId: 's9' })
  })

  test('a recent failure is shown; an old one is not', () => {
    const rows = buildAgentRows({
      agents: [agent('p1'), agent('p2')],
      tasks: [
        task('t1', 'p1', 'failed', { errorMessage: 'Build broke', updatedAt: iso(30) }),
        task('t2', 'p2', 'failed', { errorMessage: 'Old', updatedAt: iso(60 * 30) }),
      ],
      activeChats: [],
      approvals: [],
      now: NOW,
    })
    expect(rows.map((r) => [r.key, r.state, r.detail])).toEqual([['p1', 'failed', 'Build broke']])
  })

  test('running again beats an earlier failure for the same agent', () => {
    const rows = buildAgentRows({
      agents: [agent('p1')],
      tasks: [task('t1', 'p1', 'failed', { updatedAt: iso(30) }), task('t2', 'p1', 'running')],
      activeChats: [],
      approvals: [],
      now: NOW,
    })
    expect(rows[0].state).toBe('running')
  })

  test('queued comes after working and failed; a recent finish comes last', () => {
    const rows = buildAgentRows({
      agents: [agent('a'), agent('b'), agent('c'), agent('d')],
      tasks: [
        task('1', 'a', 'completed', { resultSummary: 'Sent 4 invoices', updatedAt: iso(3) }),
        task('2', 'b', 'queued'),
        task('3', 'c', 'running'),
        task('4', 'd', 'failed'),
      ],
      activeChats: [],
      approvals: [],
      now: NOW,
    })
    expect(rows.map((r) => r.state)).toEqual(['failed', 'running', 'queued', 'done'])
    expect(rows[3].detail).toBe('Sent 4 invoices')
  })

  test('idle agents are left out', () => {
    expect(buildAgentRows({ agents: [agent('p1')], tasks: [], activeChats: [], approvals: [], now: NOW })).toEqual([])
  })

  test('tasks without a project belong to the workspace agent', () => {
    const rows = buildAgentRows({
      agents: [agent(null, 'Shogo')],
      tasks: [task('t1', null, 'running')],
      activeChats: [],
      approvals: [],
      now: NOW,
    })
    expect(rows[0].key).toBe(WORKSPACE_AGENT_KEY)
  })

  test('with several approvals the newest is the one on the row', () => {
    const rows = buildAgentRows({
      agents: [agent('p1')],
      tasks: [],
      activeChats: [],
      approvals: [approval('p1', { messageId: 'old', createdAt: iso(10) }), approval('p1', { messageId: 'new', createdAt: iso(1) })],
      now: NOW,
    })
    expect(rows[0].approval?.messageId).toBe('new')
  })
})

describe('stateLabel', () => {
  test('uses plain words', () => {
    expect(stateLabel('needs_you')).toBe('Waiting for your OK')
    expect(stateLabel('running')).toBe('Working')
  })
})
