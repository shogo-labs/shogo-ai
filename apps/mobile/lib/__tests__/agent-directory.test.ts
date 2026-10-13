// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { agentWorkingOn } from '../agent-directory'

const task = (
  projectId: string | null,
  status: string,
  title: string,
  startedAt: string | null = null,
  chatSessionId: string | null = null,
) => ({ projectId, status, title, startedAt, chatSessionId }) as Parameters<typeof agentWorkingOn>[0][number]

const chat = (overrides: Partial<Parameters<typeof agentWorkingOn>[1][number]> & { projectId: string | null; sessionName: string }) =>
  ({ chatSessionId: 'session', isPrimary: false, ...overrides }) as Parameters<typeof agentWorkingOn>[1][number]

describe('agentWorkingOn', () => {
  test('a running task names what the agent is doing', () => {
    expect(agentWorkingOn([task('p1', 'running', 'Reconcile invoices')], []).get('p1')).toMatchObject({
      label: 'Working on Reconcile invoices',
      relation: 'on',
      target: { kind: 'session', projectId: 'p1', chatSessionId: null },
    })
  })

  test('finished and failed tasks do not count as work in progress', () => {
    const map = agentWorkingOn([task('p1', 'completed', 'a'), task('p2', 'failed', 'b')], [])
    expect(map.size).toBe(0)
  })

  test('the most recently started task wins', () => {
    const map = agentWorkingOn(
      [task('p1', 'running', 'older', '2026-10-01T10:00:00Z'), task('p1', 'running', 'newer', '2026-10-01T11:00:00Z')],
      [],
    )
    expect(map.get('p1')?.label).toBe('Working on newer')
  })

  test('an agent answering a chat is working, unless a task is already running', () => {
    const chats = [chat({ projectId: 'p1', sessionName: 'Plan the launch' }), chat({ projectId: 'p2', sessionName: 'Chat B', chatSessionId: 's2' })]
    const map = agentWorkingOn([task('p2', 'running', 'Task B')], chats)
    expect(map.get('p1')?.label).toBe('Working on Plan the launch')
    expect(map.get('p2')?.label).toBe('Working on Task B')
  })

  test('a channel reply opens that channel instead of the backing session', () => {
    const map = agentWorkingOn(
      [],
      [
        chat({
          projectId: 'devops',
          sessionName: '#ops: check the deploy',
          chatSessionId: 'session-ops',
          conversationId: 'conv-ops',
          threadRootId: 'thread-1',
          messageId: 'msg-1',
          conversationName: 'ops',
          conversationKind: 'public',
        }),
      ],
    )
    expect(map.get('devops')).toEqual({
      label: 'Working in #ops',
      place: '#ops',
      relation: 'in',
      target: { kind: 'conversation', conversationId: 'conv-ops', threadRootId: 'thread-1', messageId: 'msg-1' },
    })
  })

  test('a running task whose session is a channel reply points at the channel', () => {
    const map = agentWorkingOn(
      [task('devops', 'running', 'Check the deploy', '2026-10-12T18:00:00Z', 'session-ops')],
      [
        chat({
          projectId: 'devops',
          sessionName: '#ops: check the deploy',
          chatSessionId: 'session-ops',
          conversationId: 'conv-ops',
          conversationName: 'ops',
          conversationKind: 'public',
        }),
      ],
    )
    expect(map.get('devops')?.target).toEqual({
      kind: 'conversation',
      conversationId: 'conv-ops',
      threadRootId: null,
      messageId: null,
    })
    expect(map.get('devops')?.label).toBe('Working in #ops')
  })

  test('queued work shows only when nothing is running', () => {
    expect(agentWorkingOn([task('p1', 'queued', 'Waiting')], []).get('p1')?.label).toBe('Working on Waiting')
    expect(agentWorkingOn([task('p1', 'queued', 'Waiting'), task('p1', 'running', 'Doing')], []).get('p1')?.label).toBe('Working on Doing')
  })

  test('workspace-level tasks with no project are not attributed to an agent', () => {
    expect(agentWorkingOn([task(null, 'running', 'Home task')], [chat({ projectId: null, sessionName: 'x' })]).size).toBe(0)
  })
})
