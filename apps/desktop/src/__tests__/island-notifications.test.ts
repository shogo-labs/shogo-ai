// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { noticeActionFor, noticeActions, planPendingNotifications } from '../island-notifications'
import { islandSessionKey, type IslandSession, type IslandSnapshot } from '../island-protocol'

function session(over: Partial<IslandSession> & { projectId?: string; sessionId?: string } = {}): IslandSession {
  return { sessionId: 's1', projectId: 'p1', projectName: 'Acme', title: 'Chat', status: 'needs_approval', ...over }
}

const permission = (id: string, params: Record<string, unknown> = { command: 'rm -rf build' }) =>
  ({
    kind: 'permission' as const,
    request: { id, toolName: 'exec', category: 'shell', reason: 'Runs a command', params, timeout: 60, startedAt: 1 },
  })

const question = (id: string) => ({ kind: 'question' as const, request: { id, prompt: 'Which database?', options: [], answerInApp: false } })

function snap(sessions: IslandSession[], focusedSessionKey?: string): IslandSnapshot {
  return { sessions, recentProjects: [], updatedAt: 1, ...(focusedSessionKey ? { focusedSessionKey } : {}) }
}

const NO_ISLAND = { islandPresent: false }

describe('planPendingNotifications', () => {
  test('announces a new permission with the command it wants to run', () => {
    const plan = planPendingNotifications(snap([session({ pending: permission('r1') })]), new Set(), NO_ISLAND)
    expect(plan.notify).toEqual([
      { requestId: 'r1', kind: 'permission', projectId: 'p1', sessionId: 's1', title: 'Acme needs permission', body: 'exec: rm -rf build' },
    ])
    expect([...plan.announced]).toEqual(['r1'])
  })

  test('falls back to the reason when there is no command or path', () => {
    const plan = planPendingNotifications(snap([session({ pending: permission('r1', { depth: 2 }) })]), new Set(), NO_ISLAND)
    expect(plan.notify[0].body).toBe('exec: Runs a command')
  })

  test('announces a question without buttons', () => {
    const plan = planPendingNotifications(snap([session({ status: 'needs_answer', pending: question('q1') })]), new Set(), NO_ISLAND)
    expect(plan.notify).toHaveLength(1)
    expect(plan.notify[0]).toMatchObject({ kind: 'question', title: 'Acme has a question', body: 'Which database?' })
    expect(noticeActions(plan.notify[0])).toEqual([])
  })

  test('announces each request once', () => {
    const s = snap([session({ pending: permission('r1') })])
    const first = planPendingNotifications(s, new Set(), NO_ISLAND)
    const second = planPendingNotifications(s, first.announced, NO_ISLAND)
    expect(second.notify).toEqual([])
    expect([...second.announced]).toEqual(['r1'])
  })

  test('says nothing about the chat the user is looking at, and does not nag later', () => {
    const s = snap([session({ pending: permission('r1') })], islandSessionKey('p1', 's1'))
    const plan = planPendingNotifications(s, new Set(), NO_ISLAND)
    expect(plan.notify).toEqual([])
    expect(planPendingNotifications(snap([session({ pending: permission('r1') })]), plan.announced, NO_ISLAND).notify).toEqual([])
  })

  test('stays quiet when the island is showing it', () => {
    const plan = planPendingNotifications(snap([session({ pending: permission('r1') })]), new Set(), { islandPresent: true })
    expect(plan.notify).toEqual([])
    expect([...plan.announced]).toEqual(['r1'])
  })

  test('reports requests that were answered so their banners can come down', () => {
    const plan = planPendingNotifications(snap([session({ status: 'running' })]), new Set(['r1']), NO_ISLAND)
    expect(plan.resolved).toEqual(['r1'])
    expect(plan.announced.size).toBe(0)
  })

  test('announces several waiting agents', () => {
    const plan = planPendingNotifications(
      snap([session({ pending: permission('r1') }), session({ sessionId: 's2', projectId: 'p2', projectName: 'Beta', pending: question('q1') })]),
      new Set(),
      NO_ISLAND,
    )
    expect(plan.notify.map((n) => n.requestId)).toEqual(['r1', 'q1'])
  })

  test('keeps a long body to one short line', () => {
    const plan = planPendingNotifications(snap([session({ pending: permission('r1', { command: `echo\n${'x'.repeat(400)}` }) })]), new Set(), NO_ISLAND)
    expect(plan.notify[0].body.length).toBeLessThanOrEqual(180)
    expect(plan.notify[0].body).not.toContain('\n')
    expect(plan.notify[0].body.endsWith('…')).toBe(true)
  })

  test('a project with no name still reads well', () => {
    const plan = planPendingNotifications(snap([session({ projectName: '', pending: permission('r1') })]), new Set(), NO_ISLAND)
    expect(plan.notify[0].title).toBe('Agent needs permission')
  })
})

describe('notice buttons', () => {
  const [notice] = planPendingNotifications(snap([session({ pending: permission('r1') })]), new Set(), NO_ISLAND).notify

  test('a permission offers Allow and Deny, never Always allow', () => {
    expect(noticeActions(notice)).toEqual([
      { type: 'button', text: 'Allow' },
      { type: 'button', text: 'Deny' },
    ])
  })

  test('buttons map to the island permission action', () => {
    expect(noticeActionFor(notice, 0)).toEqual({ type: 'permission', requestId: 'r1', decision: 'allow_once' })
    expect(noticeActionFor(notice, 1)).toEqual({ type: 'permission', requestId: 'r1', decision: 'deny' })
    expect(noticeActionFor(notice, 2)).toBeNull()
  })

  test('a question has no answer buttons', () => {
    expect(noticeActionFor({ ...notice, kind: 'question' }, 0)).toBeNull()
  })
})
