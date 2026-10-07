// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildGlanceSnapshot } from '../../agent-glance'
import type { AgentRow } from '../../agent-urgency'
import { createLiveActivitySink, type LiveActivityApi } from '../live-activity-controller'
import { activityPropsChanged, finishedProps, leadAgent, planLiveActivity, type AgentActivityProps } from '../live-activity-plan'
import { createLiveActivityTokenSync } from '../live-activity-tokens'

const NOW = 1_000_000_000_000

function row(over: Partial<AgentRow> & { key: string }): AgentRow {
  return { projectId: over.key, name: over.key.toUpperCase(), state: 'running', detail: '', at: NOW, approval: null, taskId: null, chatSessionId: null, ...over }
}
const approval = { messageId: 'm', conversationId: 'c', summary: 'Run npm install' } as AgentRow['approval']
const snap = (rows: AgentRow[], now = NOW) => buildGlanceSnapshot({ rows, now })

describe('leadAgent', () => {
  test('prefers an agent waiting on you over one working', () => {
    const s = snap([row({ key: 'a' }), row({ key: 'b', state: 'needs_you', approval })])
    expect(leadAgent(s, NOW)?.id).toBe('b')
  })

  test('falls back to a working agent; nothing for done, queued or failed agents', () => {
    expect(leadAgent(snap([row({ key: 'a', state: 'done' }), row({ key: 'b' })]), NOW)?.id).toBe('b')
    expect(leadAgent(snap([row({ key: 'a', state: 'done' }), row({ key: 'b', state: 'queued' }), row({ key: 'c', state: 'failed' })]), NOW)).toBeNull()
  })

  test('a stale or missing snapshot has no lead', () => {
    expect(leadAgent(null, NOW)).toBeNull()
    expect(leadAgent(snap([row({ key: 'a' })]), NOW + 7 * 60 * 60 * 1000)).toBeNull()
  })
})

describe('planLiveActivity', () => {
  test('starts when an agent needs you', () => {
    const plan = planLiveActivity({ snapshot: snap([row({ key: 'a', state: 'needs_you', approval })]), running: false, now: NOW, last: null })
    expect(plan.kind).toBe('start')
    if (plan.kind !== 'start') return
    expect(plan.props).toMatchObject({
      agentId: 'a',
      agentName: 'A',
      state: 'needs_you',
      headline: '1 needs you',
      detail: 'Run npm install',
      waiting: 1,
      working: 0,
      link: 'shogo://agents/a',
      startedAt: NOW,
    })
  })

  test('starts when an agent is working', () => {
    const plan = planLiveActivity({ snapshot: snap([row({ key: 'a', detail: 'Editing checkout' })]), running: false, now: NOW, last: null })
    expect(plan).toMatchObject({ kind: 'start', props: { state: 'running', headline: '1 working', detail: 'Editing checkout' } })
  })

  test('does nothing when nothing is happening and nothing is showing', () => {
    expect(planLiveActivity({ snapshot: snap([row({ key: 'a', state: 'done' })]), running: false, now: NOW, last: null })).toEqual({ kind: 'none' })
  })

  test('updates when what it shows changes, and keeps its start time for the same agent', () => {
    const first = planLiveActivity({ snapshot: snap([row({ key: 'a' })]), running: false, now: NOW, last: null })
    if (first.kind !== 'start') throw new Error('expected start')
    const later = planLiveActivity({
      snapshot: snap([row({ key: 'a', state: 'needs_you', approval })], NOW + 5000),
      running: true,
      now: NOW + 5000,
      last: first.props,
    })
    expect(later.kind).toBe('update')
    if (later.kind !== 'update') return
    expect(later.props.state).toBe('needs_you')
    expect(later.props.startedAt).toBe(NOW)
  })

  test('a different agent restarts the clock', () => {
    const first = planLiveActivity({ snapshot: snap([row({ key: 'a' })]), running: false, now: NOW, last: null })
    if (first.kind !== 'start') throw new Error('expected start')
    const next = planLiveActivity({ snapshot: snap([row({ key: 'b' })], NOW + 9000), running: true, now: NOW + 9000, last: first.props })
    expect(next).toMatchObject({ kind: 'update', props: { agentId: 'b', startedAt: NOW + 9000 } })
  })

  test('does not update when nothing it shows has changed', () => {
    const first = planLiveActivity({ snapshot: snap([row({ key: 'a' })]), running: false, now: NOW, last: null })
    if (first.kind !== 'start') throw new Error('expected start')
    expect(planLiveActivity({ snapshot: snap([row({ key: 'a' })], NOW + 1000), running: true, now: NOW + 1000, last: first.props })).toEqual({ kind: 'none' })
  })

  test('ends with a "Done" card when nothing is left', () => {
    const first = planLiveActivity({ snapshot: snap([row({ key: 'a' })]), running: false, now: NOW, last: null })
    if (first.kind !== 'start') throw new Error('expected start')
    const end = planLiveActivity({ snapshot: snap([row({ key: 'a', state: 'done' })]), running: true, now: NOW + 1000, last: first.props })
    expect(end).toEqual({ kind: 'end', props: finishedProps(first.props) })
    expect(finishedProps(first.props)).toMatchObject({ state: 'done', headline: 'Done', detail: 'Finished', waiting: 0, working: 0 })
  })

  test('ends an activity from an earlier launch even though this launch never saw it', () => {
    expect(planLiveActivity({ snapshot: snap([]), running: true, now: NOW, last: null })).toEqual({ kind: 'end', props: null })
  })
})

describe('activityPropsChanged', () => {
  const base: AgentActivityProps = {
    agentId: 'a', agentName: 'A', state: 'running', headline: '1 working', detail: '', color: '#3b5bdb', waiting: 0, working: 1, link: 'shogo://agents/a', startedAt: 1,
  }
  test('ignores the start time only', () => {
    expect(activityPropsChanged(base, { ...base, startedAt: 99 })).toBe(false)
    expect(activityPropsChanged(base, { ...base, detail: 'x' })).toBe(true)
    expect(activityPropsChanged(null, base)).toBe(true)
  })
})

function fakeApi(running = false) {
  const calls: string[] = []
  const api: LiveActivityApi = {
    isRunning: () => running,
    start: (p) => (calls.push(`start:${p.agentId}`), void (running = true)),
    update: (p) => void calls.push(`update:${p.state}`),
    end: (p) => (calls.push(`end:${p?.state ?? 'none'}`), void (running = false)),
  }
  return { api, calls }
}

describe('createLiveActivitySink', () => {
  test('follows an agent from working, to needing you, to done', async () => {
    const { api, calls } = fakeApi()
    const sink = createLiveActivitySink(api, () => NOW)
    await sink(snap([row({ key: 'a' })]))
    await sink(snap([row({ key: 'a' })]))
    await sink(snap([row({ key: 'a', state: 'needs_you', approval })]))
    await sink(snap([row({ key: 'a', state: 'done' })]))
    await sink(snap([row({ key: 'a', state: 'done' })]))
    expect(calls).toEqual(['start:a', 'update:needs_you', 'end:done'])
  })

  test('after the activity ends, a new run starts a new one', async () => {
    const { api, calls } = fakeApi()
    const sink = createLiveActivitySink(api, () => NOW)
    await sink(snap([row({ key: 'a' })]))
    await sink(snap([]))
    await sink(snap([row({ key: 'b' })]))
    expect(calls).toEqual(['start:a', 'end:done', 'start:b'])
  })
})

describe('createLiveActivityTokenSync', () => {
  function sync(fail = false) {
    const bodies: any[] = []
    let failing = fail
    const tokens = createLiveActivityTokenSync(async (body) => {
      if (failing) throw new Error('offline')
      bodies.push(body)
    })
    return { tokens, bodies, recover: () => void (failing = false) }
  }

  test('waits for the device push token before telling the server anything', async () => {
    const { tokens, bodies } = sync()
    await tokens.setPushToStartToken('aa')
    await tokens.setActivityToken('bb')
    expect(bodies).toEqual([])
    await tokens.setPushToken('ExponentPushToken[x]')
    expect(bodies).toEqual([{ pushToken: 'ExponentPushToken[x]', activityToken: 'bb', pushToStartToken: 'aa' }])
  })

  test('sends only what changed, and nothing twice', async () => {
    const { tokens, bodies } = sync()
    await tokens.setPushToken('p')
    await tokens.setActivityToken('bb')
    await tokens.setActivityToken('bb')
    await tokens.setPushToStartToken('aa')
    await tokens.setActivityToken(null)
    expect(bodies).toEqual([
      { pushToken: 'p', activityToken: 'bb' },
      { pushToken: 'p', pushToStartToken: 'aa' },
      { pushToken: 'p', activityToken: null },
    ])
  })

  test('retries after a failure, and again for a different device', async () => {
    const { tokens, bodies, recover } = sync(true)
    await tokens.setPushToken('p')
    await tokens.setActivityToken('bb')
    expect(bodies).toEqual([])
    recover()
    await tokens.setPushToStartToken('aa')
    expect(bodies).toEqual([{ pushToken: 'p', activityToken: 'bb', pushToStartToken: 'aa' }])
    await tokens.setPushToken('p2')
    expect(bodies[1]).toEqual({ pushToken: 'p2', activityToken: 'bb', pushToStartToken: 'aa' })
  })

  test('signing out sends nothing', async () => {
    const { tokens, bodies } = sync()
    await tokens.setPushToken('p')
    await tokens.setActivityToken('bb')
    await tokens.setPushToken(null)
    expect(bodies).toHaveLength(1)
  })
})
