// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ACTIVITY_CHANNEL_FILTERS,
  EMPTY_ACTIVITY_FILTER,
  isActivityFilterActive,
  matchesActivityFilter,
  matchesActivityFilters,
  type ActivityChannelFilter,
  type ActivityFilterState,
} from '../activity-channel-filters'
import type { ChatMessage } from '../team-chat-api'

function line(kind: string | null, extra: Record<string, unknown> = {}, type = 'activity'): Pick<ChatMessage, 'blocks'> {
  if (!kind) return { blocks: null }
  return { blocks: { type, kind, ...extra } }
}

describe('matchesActivityFilter', () => {
  test('all shows every message', () => {
    expect(matchesActivityFilter(line(null), 'all')).toBe(true)
    expect(matchesActivityFilter(line('agent.message'), 'all')).toBe(true)
    expect(matchesActivityFilter({ blocks: { type: 'status_card' } }, 'all')).toBe(true)
  })

  test('each chip matches only its kinds', () => {
    const cases: Array<[ActivityChannelFilter, string]> = [
      ['agent_messages', 'agent.message'],
      ['tasks', 'task.completed'],
      ['tasks', 'task.failed'],
      ['schedules', 'schedule.ok'],
      ['schedules', 'schedule.failed'],
      ['goals', 'goal.event'],
      ['publishes', 'project.published'],
      ['members', 'member.joined'],
    ]
    for (const [filter, kind] of cases) {
      expect(matchesActivityFilter(line(kind), filter)).toBe(true)
      for (const other of ACTIVITY_CHANNEL_FILTERS) {
        if (other.id === 'all' || other.id === filter) continue
        expect(matchesActivityFilter(line(kind), other.id)).toBe(false)
      }
    }
  })

  test('messages that are not activity lines match no chip', () => {
    const plain = { blocks: { type: 'status_card', kind: 'task.completed' } }
    for (const { id } of ACTIVITY_CHANNEL_FILTERS) {
      if (id === 'all') continue
      expect(matchesActivityFilter(line(null), id)).toBe(false)
      expect(matchesActivityFilter(plain, id)).toBe(false)
      expect(matchesActivityFilter(line('note'), id)).toBe(false)
    }
  })
})

describe('matchesActivityFilters', () => {
  const open: ActivityFilterState = { ...EMPTY_ACTIVITY_FILTER }

  test('an open filter shows every message', () => {
    expect(isActivityFilterActive(open)).toBe(false)
    expect(matchesActivityFilters(line(null), open)).toBe(true)
    expect(matchesActivityFilters(line('agent.message'), open)).toBe(true)
    expect(isActivityFilterActive({ ...open, kind: 'tasks' })).toBe(true)
    expect(isActivityFilterActive({ ...open, agentKeys: ['ws'] })).toBe(true)
    expect(isActivityFilterActive({ ...open, conversationIds: ['c-eng'] })).toBe(true)
  })

  test('an agent matches its project, and ws matches lines with no project', () => {
    const billing = line('task.completed', { projectId: 'proj-1' })
    const workspace = line('schedule.ok', { projectId: null })
    const goal = line('goal.event')
    const member = line('member.joined', { projectId: null, actorUserId: 'u-1' })
    expect(matchesActivityFilters(billing, { ...open, agentKeys: ['p:proj-1'] })).toBe(true)
    expect(matchesActivityFilters(workspace, { ...open, agentKeys: ['p:proj-1'] })).toBe(false)
    expect(matchesActivityFilters(workspace, { ...open, agentKeys: ['ws'] })).toBe(true)
    expect(matchesActivityFilters(goal, { ...open, agentKeys: ['ws'] })).toBe(true)
    expect(matchesActivityFilters(billing, { ...open, agentKeys: ['ws'] })).toBe(false)
    expect(matchesActivityFilters(member, { ...open, agentKeys: ['ws'] })).toBe(false)
    expect(matchesActivityFilters(member, { ...open, agentKeys: ['p:proj-1'] })).toBe(false)
    expect(matchesActivityFilters(line(null), { ...open, agentKeys: ['ws'] })).toBe(false)
  })

  test('several agents or channels match when the line belongs to any of them', () => {
    const billing = line('task.completed', { projectId: 'proj-1', conversationId: 'c-eng' })
    const workspace = line('schedule.ok', { projectId: null, conversationId: 'c-ops' })
    const support = line('agent.message', { projectId: 'proj-2', conversationId: 'c-eng' })
    const eitherAgent = { ...open, agentKeys: ['p:proj-1', 'ws'] }
    expect(matchesActivityFilters(billing, eitherAgent)).toBe(true)
    expect(matchesActivityFilters(workspace, eitherAgent)).toBe(true)
    expect(matchesActivityFilters(support, eitherAgent)).toBe(false)
    const eitherChannel = { ...open, conversationIds: ['c-eng', 'c-ops'] }
    expect(matchesActivityFilters(billing, eitherChannel)).toBe(true)
    expect(matchesActivityFilters(workspace, eitherChannel)).toBe(true)
    expect(matchesActivityFilters(line('goal.event'), eitherChannel)).toBe(false)
    expect(matchesActivityFilters(support, { ...open, agentKeys: ['p:proj-2'], conversationIds: ['c-ops'] })).toBe(false)
    expect(matchesActivityFilters(support, { ...open, agentKeys: ['p:proj-2'], conversationIds: ['c-eng', 'c-ops'] })).toBe(true)
  })

  test('a channel matches the conversation the line was posted about', () => {
    const posted = line('agent.message', { conversationId: 'c-eng', projectId: 'proj-1' })
    const delivered = line('task.completed', { conversationId: 'c-eng', projectId: 'proj-1' })
    const other = line('agent.message', { conversationId: 'c-ops', projectId: 'proj-1' })
    expect(matchesActivityFilters(posted, { ...open, conversationIds: ['c-eng'] })).toBe(true)
    expect(matchesActivityFilters(delivered, { ...open, conversationIds: ['c-eng'] })).toBe(true)
    expect(matchesActivityFilters(other, { ...open, conversationIds: ['c-eng'] })).toBe(false)
    expect(matchesActivityFilters(line('goal.event'), { ...open, conversationIds: ['c-eng'] })).toBe(false)
  })

  test('kind, agent, and channel all have to match', () => {
    const message = line('agent.message', { conversationId: 'c-eng', projectId: 'proj-1' })
    const task = line('task.completed', { conversationId: 'c-eng', projectId: 'proj-1' })
    const filter: ActivityFilterState = { kind: 'agent_messages', agentKeys: ['p:proj-1'], conversationIds: ['c-eng'] }
    expect(matchesActivityFilters(message, filter)).toBe(true)
    expect(matchesActivityFilters(task, filter)).toBe(false)
    expect(matchesActivityFilters(message, { ...filter, agentKeys: ['ws'] })).toBe(false)
    expect(matchesActivityFilters(message, { ...filter, conversationIds: ['c-ops'] })).toBe(false)
  })
})
