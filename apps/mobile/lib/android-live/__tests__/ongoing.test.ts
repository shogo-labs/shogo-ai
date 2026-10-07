// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildGlanceSnapshot } from '../../agent-glance'
import type { AgentRow } from '../../agent-urgency'
import { createOngoingSink, type OngoingNotifier } from '../ongoing-controller'
import { ONGOING_ID, planOngoingNotification, type OngoingContent } from '../ongoing-plan'

const NOW = 1_000_000_000_000

function row(over: Partial<AgentRow> & { key: string }): AgentRow {
  return { projectId: over.key, name: over.key.toUpperCase(), state: 'running', detail: '', at: NOW, approval: null, taskId: null, chatSessionId: null, ...over }
}
const approval = { messageId: 'm1', conversationId: 'c1', summary: 'Run npm install' } as AgentRow['approval']
const snap = (rows: AgentRow[], now = NOW) => buildGlanceSnapshot({ rows, now })

describe('planOngoingNotification', () => {
  test('a waiting agent shows what it wants, with Approve and Deny', () => {
    const plan = planOngoingNotification(snap([row({ key: 'a', state: 'needs_you', approval })]), NOW)
    expect(plan).toEqual({
      kind: 'show',
      content: {
        title: 'A needs you',
        body: 'Run npm install',
        color: '#3B5BDB',
        categoryId: 'agent-approval',
        data: { url: 'shogo://agents/a', approvalMessageId: 'm1', conversationId: 'c1' },
      },
    })
  })

  test('a working agent shows what it is doing, with no buttons', () => {
    const plan = planOngoingNotification(snap([row({ key: 'a', detail: 'Editing checkout' })]), NOW)
    expect(plan).toMatchObject({ kind: 'show', content: { title: 'A is working', body: 'Editing checkout', categoryId: null, data: { url: 'shogo://agents/a' } } })
  })

  test('says how many are going on when there are several', () => {
    const plan = planOngoingNotification(snap([row({ key: 'a', state: 'needs_you', approval }), row({ key: 'b' })]), NOW)
    expect(plan).toMatchObject({ kind: 'show', content: { body: 'Run npm install · 1 needs you' } })
  })

  test('a waiting agent that is not an approval (no card to answer) has no buttons', () => {
    const plan = planOngoingNotification(snap([row({ key: 'a', state: 'needs_you' })]), NOW)
    expect(plan).toMatchObject({ kind: 'show', content: { categoryId: null } })
    if (plan.kind === 'show') expect(plan.content.data.approvalMessageId).toBeUndefined()
  })

  test('clears when nothing needs you or is working, or the snapshot is old', () => {
    expect(planOngoingNotification(snap([row({ key: 'a', state: 'done' })]), NOW)).toEqual({ kind: 'clear' })
    expect(planOngoingNotification(null, NOW)).toEqual({ kind: 'clear' })
    expect(planOngoingNotification(snap([row({ key: 'a' })]), NOW + 7 * 60 * 60 * 1000)).toEqual({ kind: 'clear' })
  })

  test('uses a fixed id so each post replaces the last', () => {
    expect(ONGOING_ID).toBe('agent-live')
  })
})

describe('createOngoingSink', () => {
  function fake() {
    const calls: string[] = []
    const notifier: OngoingNotifier = {
      present: (c: OngoingContent) => void calls.push(`present:${c.title}`),
      clear: () => void calls.push('clear'),
    }
    return { calls, sink: createOngoingSink(notifier, () => NOW) }
  }

  test('posts on change only, and clears once', async () => {
    const { calls, sink } = fake()
    await sink(snap([]))
    await sink(snap([row({ key: 'a' })]))
    await sink(snap([row({ key: 'a' })]))
    await sink(snap([row({ key: 'a', state: 'needs_you', approval })]))
    await sink(snap([row({ key: 'a', state: 'done' })]))
    await sink(snap([row({ key: 'a', state: 'done' })]))
    expect(calls).toEqual(['present:A is working', 'present:A needs you', 'clear'])
  })
})
