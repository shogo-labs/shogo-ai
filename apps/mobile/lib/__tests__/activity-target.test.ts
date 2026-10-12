// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { activityTarget } from '../activity-target'

const activity = (kind: string, extra: Record<string, unknown> = {}) => ({ type: 'activity', kind, ...extra })

describe('activityTarget', () => {
  test('an agent message opens that message, and a thread reply opens the thread', () => {
    expect(activityTarget(activity('agent.message', { conversationId: 'c1', messageId: 'm1' }))).toEqual({
      type: 'route',
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: 'c1', msg: 'm1' },
    })
    expect(activityTarget(activity('agent.message', { conversationId: 'c1', messageId: 'm1', threadRootId: 'root' }))?.params).toEqual({
      conversationId: 'c1',
      msg: 'm1',
      thread: 'root',
    })
  })

  test('a task opens its session, or the task list when it has none', () => {
    expect(activityTarget(activity('task.completed', { projectId: 'p1', chatSessionId: 's1', taskId: 't1' }))).toEqual({
      type: 'route',
      pathname: '/(app)/projects/[id]',
      params: { id: 'p1', chatSessionId: 's1' },
    })
    expect(activityTarget(activity('task.failed', { chatSessionId: 's1', taskId: 't1' }))).toEqual({
      type: 'route',
      pathname: '/(app)/agent',
      params: { chatSessionId: 's1' },
    })
    expect(activityTarget(activity('task.completed', { taskId: 't1' }))).toEqual({
      type: 'route',
      pathname: '/(app)/tasks',
      params: { taskId: 't1' },
    })
  })

  test('schedules, goals, and publishes each open their own place', () => {
    expect(activityTarget(activity('schedule.ok', { chatSessionId: 's2' }))).toEqual({
      type: 'route',
      pathname: '/(app)/agent',
      params: { chatSessionId: 's2' },
    })
    expect(activityTarget(activity('goal.event', { goalId: 'g1' }))).toEqual({
      type: 'route',
      pathname: '/(app)/goals/[id]',
      params: { id: 'g1' },
    })
    expect(activityTarget(activity('project.published', { link: 'https://billing.shogo.one' }))).toEqual({
      type: 'url',
      url: 'https://billing.shogo.one',
    })
  })

  test('a member line and an old line with no metadata go nowhere', () => {
    expect(activityTarget(activity('member.joined'))).toBeNull()
    expect(activityTarget(activity('task.completed'))).toBeNull()
    expect(activityTarget(activity('schedule.failed'))).toBeNull()
    expect(activityTarget(null)).toBeNull()
    expect(activityTarget({ type: 'status_card', kind: 'task.completed' })).toBeNull()
  })
})
