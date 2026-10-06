// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, test } from 'bun:test'
import { FALLBACK_GLOW } from '../agent-glow'
import {
  agentDeepLink,
  buildGlanceSnapshot,
  glanceChanged,
  GLANCE_MAX_AGENTS,
  parseAgentDeepLink,
} from '../agent-glance'
import { _resetGlanceForTests, publishGlance, registerGlanceSink } from '../glance-publisher'
import type { AgentRow } from '../agent-urgency'

const row = (key: string, state: AgentRow['state'], over: Partial<AgentRow> = {}): AgentRow => ({
  key,
  projectId: key === 'ws' ? null : key,
  name: `Agent ${key}`,
  state,
  detail: `${key} detail`,
  at: 1000,
  approval: null,
  taskId: null,
  chatSessionId: null,
  ...over,
})

describe('deep links', () => {
  test('round trip, including ids that need escaping', () => {
    expect(agentDeepLink('abc')).toBe('shogo://agents/abc')
    expect(parseAgentDeepLink(agentDeepLink('a b/c'))).toBe('a b/c')
  })

  test('only agent links parse', () => {
    expect(parseAgentDeepLink('shogo://agents/p1?x=1')).toBe('p1')
    expect(parseAgentDeepLink('shogo://agents/')).toBeNull()
    expect(parseAgentDeepLink('shogo://projects/p1')).toBeNull()
    expect(parseAgentDeepLink('https://example.com/agents/p1')).toBeNull()
    expect(parseAgentDeepLink(null)).toBeNull()
    expect(parseAgentDeepLink('shogo://agents/%E0%A4%A')).toBeNull()
  })
})

describe('buildGlanceSnapshot', () => {
  test('carries state, label, colour and link per agent, and counts', () => {
    const snap = buildGlanceSnapshot({
      rows: [
        row('p1', 'needs_you', { approval: { messageId: 'm1', conversationId: 'c1', summary: 'Run: ls' } as any }),
        row('p2', 'running'),
        row('p3', 'done'),
      ],
      colors: { p1: '#FB8C00', p2: '#ffffff' },
      workspaceId: 'w1',
      now: 5,
    })
    expect(snap).toMatchObject({ version: 1, generatedAt: 5, workspaceId: 'w1', waiting: 1, working: 1 })
    expect(snap.agents[0]).toMatchObject({
      id: 'p1',
      stateLabel: 'Waiting for your OK',
      color: '#fb8c00',
      link: 'shogo://agents/p1',
      approval: { messageId: 'm1', conversationId: 'c1', summary: 'Run: ls' },
    })
    // White would be a grey haze; a missing colour likewise.
    expect(snap.agents[1].color).toBe(FALLBACK_GLOW)
    expect(snap.agents[2].color).toBe(FALLBACK_GLOW)
    expect(snap.agents[1].approval).toBeNull()
  })

  test('cuts the list to widget size, but counts every agent', () => {
    const rows = Array.from({ length: GLANCE_MAX_AGENTS + 4 }, (_, i) => row(`p${i}`, i === GLANCE_MAX_AGENTS + 2 ? 'needs_you' : 'running'))
    const snap = buildGlanceSnapshot({ rows, now: 1 })
    expect(snap.agents).toHaveLength(GLANCE_MAX_AGENTS)
    expect(snap.working).toBe(GLANCE_MAX_AGENTS + 3)
    expect(snap.waiting).toBe(1)
  })

  test('a question rides along on its agent', () => {
    const snap = buildGlanceSnapshot({
      rows: [row('p1', 'needs_you')],
      questions: { p1: { id: 'q1', prompt: 'Which env?', options: ['staging', 'prod'] } },
      now: 1,
    })
    expect(snap.agents[0].question).toEqual({ id: 'q1', prompt: 'Which env?', options: ['staging', 'prod'] })
  })
})

describe('glanceChanged', () => {
  test('ignores the time it was built, notices real differences', () => {
    const a = buildGlanceSnapshot({ rows: [row('p1', 'running')], now: 1 })
    const b = buildGlanceSnapshot({ rows: [row('p1', 'running')], now: 99 })
    const c = buildGlanceSnapshot({ rows: [row('p1', 'done')], now: 99 })
    expect(glanceChanged(null, a)).toBe(true)
    expect(glanceChanged(a, b)).toBe(false)
    expect(glanceChanged(a, c)).toBe(true)
  })
})

describe('publishGlance', () => {
  beforeEach(() => _resetGlanceForTests())

  test('sends only changes, and a late sink gets the latest at once', async () => {
    const seen: number[] = []
    registerGlanceSink((s) => void seen.push(s.waiting))
    expect(await publishGlance(buildGlanceSnapshot({ rows: [row('p1', 'running')], now: 1 }))).toBe(true)
    expect(await publishGlance(buildGlanceSnapshot({ rows: [row('p1', 'running')], now: 2 }))).toBe(false)
    expect(await publishGlance(buildGlanceSnapshot({ rows: [row('p1', 'needs_you')], now: 3 }))).toBe(true)
    expect(seen).toEqual([0, 1])

    const late: number[] = []
    registerGlanceSink((s) => void late.push(s.waiting))
    await Promise.resolve()
    expect(late).toEqual([1])
  })

  test('one failing sink does not stop the others', async () => {
    const seen: number[] = []
    registerGlanceSink(() => {
      throw new Error('boom')
    })
    registerGlanceSink((s) => void seen.push(s.agents.length))
    await publishGlance(buildGlanceSnapshot({ rows: [row('p1', 'running')], now: 1 }))
    expect(seen).toEqual([1])
  })
})
