// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { describeEvent } from '../work-history'
import type { Mentionables } from '../team-chat-api'
import type { WorkItemEvent } from '../work-boards-api'

const mentionables: Mentionables = {
  people: [{ id: 'u1', name: 'Ada', email: 'ada@x', image: null, role: 'member' }],
  agents: [{ key: 'p:p1', projectId: 'p1', name: 'Support bot', description: null, image: null }],
}

function event(type: string, data: Record<string, unknown> | null, actor: Partial<WorkItemEvent> = { actorUserId: 'u1' }): WorkItemEvent {
  return { id: 'e', type, actorUserId: null, actorAgentRef: null, sessionId: null, data, createdAt: '', ...actor }
}

describe('describeEvent', () => {
  test('moves name both columns, and both boards when it changed board', () => {
    expect(describeEvent(event('moved', { from: { column: 'Triage' }, to: { column: 'Doing' } }), mentionables)).toBe('Ada moved it from Triage to Doing')
    expect(describeEvent(event('moved', { from: { board: 'Support', column: 'Open' }, to: { board: 'Eng', column: 'Backlog' } }), mentionables))
      .toBe('Ada moved it from Support › Open to Eng › Backlog')
    expect(describeEvent(event('moved', { from: { column: 'Doing' }, to: { column: 'Needs attention' }, reason: 'agent_failed' }, {}), mentionables))
      .toBe('Shogo moved it from Doing to Needs attention after the agent hit an error')
  })

  test('agents are named from mentionables', () => {
    expect(describeEvent(event('assigned', { label: 'Support bot' }, { actorAgentRef: 'project:p1' }), mentionables)).toBe('Support bot assigned it to Support bot')
    expect(describeEvent(event('agent_woken', { agentRef: 'project:p1', reason: 'assigned' }), mentionables)).toBe('Support bot picked it up (assigned)')
  })

  test('edits, occurrences and quiet events', () => {
    expect(describeEvent(event('updated', { changed: ['title', 'priority'] }), mentionables)).toBe('Ada changed the title, the priority')
    expect(describeEvent(event('occurrence', { environment: 'prod', release: 'v2' }), mentionables)).toBe('It happened again in prod on v2')
    expect(describeEvent(event('agent_wake_skipped', { reason: 'no_channel' }), mentionables)).toBeNull()
    expect(describeEvent(event('mystery', null), mentionables)).toBeNull()
  })
})
