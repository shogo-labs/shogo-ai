// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { ACTIVITY_CHANNEL_FILTERS, matchesActivityFilter, type ActivityChannelFilter } from '../activity-channel-filters'
import type { ChatMessage } from '../team-chat-api'

function line(kind: string | null, type = 'activity'): Pick<ChatMessage, 'blocks'> {
  if (!kind) return { blocks: null }
  return { blocks: { type, kind } }
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
