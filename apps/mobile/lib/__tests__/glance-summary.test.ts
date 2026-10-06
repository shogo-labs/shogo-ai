// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildGlanceSnapshot } from '../agent-glance'
import { GLANCE_STALE_MS, glanceAgentSubtitle, glanceAgents, glanceHeadline, isGlanceStale } from '../glance-summary'
import type { AgentRow } from '../agent-urgency'

const NOW = 1_000_000_000_000

function row(over: Partial<AgentRow> & { key: string }): AgentRow {
  return {
    projectId: over.key,
    name: over.key.toUpperCase(),
    state: 'running',
    detail: '',
    at: NOW,
    approval: null,
    taskId: null,
    chatSessionId: null,
    ...over,
  }
}

const snap = (rows: AgentRow[], now = NOW) => buildGlanceSnapshot({ rows, now })

describe('glanceHeadline', () => {
  test('waiting wins over working', () => {
    expect(glanceHeadline(snap([row({ key: 'a', state: 'needs_you' }), row({ key: 'b' })]), NOW)).toBe('1 needs you')
    expect(glanceHeadline(snap([row({ key: 'a', state: 'needs_you' }), row({ key: 'b', state: 'needs_you' })]), NOW)).toBe('2 need you')
  })

  test('counts what is working', () => {
    expect(glanceHeadline(snap([row({ key: 'a' })]), NOW)).toBe('1 working')
    expect(glanceHeadline(snap([row({ key: 'a' }), row({ key: 'b' })]), NOW)).toBe('2 working')
  })

  test('says all quiet when nothing needs you or is working', () => {
    expect(glanceHeadline(snap([row({ key: 'a', state: 'done' })]), NOW)).toBe('All quiet')
    expect(glanceHeadline(snap([]), NOW)).toBe('All quiet')
  })

  test('asks you to open the app when there is nothing or it is old', () => {
    expect(glanceHeadline(null, NOW)).toBe('Open Shogo')
    expect(glanceHeadline(snap([row({ key: 'a' })]), NOW + GLANCE_STALE_MS + 1)).toBe('Open Shogo')
  })
})

describe('staleness', () => {
  test('a snapshot goes stale after six hours', () => {
    const s = snap([])
    expect(isGlanceStale(s, NOW + GLANCE_STALE_MS)).toBe(false)
    expect(isGlanceStale(s, NOW + GLANCE_STALE_MS + 1)).toBe(true)
    expect(isGlanceStale(null, NOW)).toBe(true)
  })

  test('stale snapshots show no agents', () => {
    expect(glanceAgents(snap([row({ key: 'a' })]), NOW + GLANCE_STALE_MS + 1, 3)).toEqual([])
  })
})

describe('glanceAgents and subtitles', () => {
  test('cuts to the limit', () => {
    const s = snap([row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' }), row({ key: 'd' })])
    expect(glanceAgents(s, NOW, 3).map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  test('an approval says what it wants; otherwise the detail; otherwise the state', () => {
    const approval = { messageId: 'm', conversationId: 'c', summary: 'Run npm install' }
    const [waiting, working, idle] = snap([
      row({ key: 'a', state: 'needs_you', approval: approval as AgentRow['approval'] }),
      row({ key: 'b', detail: 'Editing checkout' }),
      row({ key: 'c', state: 'queued' }),
    ]).agents
    expect(glanceAgentSubtitle(waiting)).toBe('Run npm install')
    expect(glanceAgentSubtitle(working)).toBe('Editing checkout')
    expect(glanceAgentSubtitle(idle)).toBe('Queued')
  })
})
