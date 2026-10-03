// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { agentWorkingOn } from '../agent-directory'

const task = (projectId: string | null, status: string, title: string, startedAt: string | null = null) =>
  ({ projectId, status, title, startedAt }) as Parameters<typeof agentWorkingOn>[0][number]

describe('agentWorkingOn', () => {
  test('a running task names what the agent is doing', () => {
    expect(agentWorkingOn([task('p1', 'running', 'Reconcile invoices')], []).get('p1')).toBe('Reconcile invoices')
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
    expect(map.get('p1')).toBe('newer')
  })

  test('an agent answering a chat is working, unless a task is already running', () => {
    const chats = [{ projectId: 'p1', sessionName: 'Plan the launch' }, { projectId: 'p2', sessionName: 'Chat B' }]
    const map = agentWorkingOn([task('p2', 'running', 'Task B')], chats)
    expect(map.get('p1')).toBe('Plan the launch')
    expect(map.get('p2')).toBe('Task B')
  })

  test('queued work shows only when nothing is running', () => {
    expect(agentWorkingOn([task('p1', 'queued', 'Waiting')], []).get('p1')).toBe('Waiting')
    expect(agentWorkingOn([task('p1', 'queued', 'Waiting'), task('p1', 'running', 'Doing')], []).get('p1')).toBe('Doing')
  })

  test('workspace-level tasks with no project are not attributed to an agent', () => {
    expect(agentWorkingOn([task(null, 'running', 'Home task')], [{ projectId: null, sessionName: 'x' }]).size).toBe(0)
  })
})
