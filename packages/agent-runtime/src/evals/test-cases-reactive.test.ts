// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { CompanyWorld, type SimWake, type WorldSnapshot } from './company-sim/world'
import { firesPerDay, nextCronFire } from './company-sim/cron'
import { REACTIVE_EVALS, PHASE0, handoffLags, pollingTimers, reactionHours } from './test-cases-reactive'
import type { AgentEval, EvalResult } from './types'

const byId = (id: string) => REACTIVE_EVALS.find((e) => e.id === id)!

function grade(e: AgentEval, sim: WorldSnapshot, responseText: string): Record<string, boolean> {
  const r = { sim, responseText, toolCalls: [] } as unknown as EvalResult
  return Object.fromEntries(e.validationCriteria.map((c) => [c.id, c.validate(r)]))
}

/** The runner's wake loop with a scripted agent standing in for the model. */
function play(e: AgentEval, turn: (w: CompanyWorld, wake: SimWake | null) => void): WorldSnapshot {
  const w = new CompanyWorld(e.sim!)
  turn(w, null)
  for (let n = 0; n < (e.sim!.wakes!.maxWakes ?? 12); n++) {
    const wake = w.nextWake()
    if (!wake) break
    turn(w, wake)
  }
  return w.snapshot()
}

const nextOpen = (s: WorldSnapshot) => PHASE0.find((c) => s.items.find((i) => i.key === c.key)!.column === 'Backlog')

/** Close what is in Review and hand the next card on; with `waitOn`, block on the handoff's task like Claude Code would. */
function advancePhase(w: CompanyWorld, waitOn = false): void {
  for (let guard = 0; guard < PHASE0.length; guard++) {
    const s = w.snapshot()
    for (const i of s.items.filter((x) => x.column === 'Review')) w.handle('work_item_move', { item: i.key, column: 'Done' })
    if (w.snapshot().items.some((i) => i.column === 'In progress')) return
    const next = nextOpen(w.snapshot())
    if (!next) return
    const out = w.handle('work_item_update', { item: next.key, assignee_agent: 'Samsara Engineer' }) as { task_id?: string }
    if (!waitOn || !out.task_id) return
    w.handle('wait', { task_ids: [out.task_id] })
  }
}

const reactive = (waitOn = false) => (w: CompanyWorld) => advancePhase(w, waitOn)
const poller = (w: CompanyWorld, wake: SimWake | null) => {
  if (!wake) w.handle('schedule_create', { name: 'Samsara check-in', prompt: 'Check the Phase 0 board and keep it moving.', cron: '0 * * * *' })
  advancePhase(w)
}

const REACTIVE_REPLY = 'Closed P0-1 and handed P0-2 to Samsara Engineer. I will close each card and hand on the next as soon as it lands in Review.'
const POLLING_REPLY = 'Done. I set up an hourly check-in and will check back every hour.'

describe('cron', () => {
  test('next fire and fires per day', () => {
    expect(nextCronFire('0 * * * *', new Date('2026-10-14T15:00:00Z'), new Date('2026-10-15T00:00:00Z'))!.toISOString()).toBe('2026-10-14T16:00:00.000Z')
    expect(nextCronFire('0 9 * * 1', new Date('2026-10-14T15:00:00Z'), new Date('2026-10-30T00:00:00Z'))!.toISOString()).toBe('2026-10-19T09:00:00.000Z')
    expect(firesPerDay('*/30 * * * *')).toBe(48)
    expect(firesPerDay('0 */2 * * *')).toBe(12)
    expect(firesPerDay('0 9 * * *')).toBe(1)
    expect(nextCronFire('bad cron', new Date(), new Date())).toBeNull()
  })
})

describe('wakes', () => {
  test('a watched handoff wakes the agent the moment the card lands in Review', () => {
    const w = new CompanyWorld(byId('react-monitor-phase').sim!)
    const out = w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' }) as Record<string, unknown>
    expect(out.watching).toBe(true)
    expect(w.nextWake()).toMatchObject({ kind: 'heartbeat', at: '2026-10-14T19:00:00.000Z', runs: [] })
    const wake = w.nextWake()!
    expect(wake.kind).toBe('task')
    expect(wake.text).toMatch(/^\[Task update\] P0-2 Simulation kernel \(t_sim\d+\) completed\.\nLast output:\nmoved to Review \(review\)/)
    expect(wake.at).toBe('2026-10-14T22:00:00.000Z')
  })

  test('without the platform watching, the heartbeat finds it first', () => {
    const w = new CompanyWorld(byId('react-monitor-phase-unwatched').sim!)
    const out = w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' }) as Record<string, unknown>
    expect(out.watching).toBeUndefined()
    const first = w.nextWake()!
    expect(first.kind).toBe('heartbeat')
    expect(first.runs).toEqual([])
    const second = w.nextWake()!
    expect(second.kind).toBe('heartbeat')
    expect(second.at).toBe('2026-10-14T23:00:00.000Z')
    expect(second.runs.length).toBe(1)
  })

  test('a stall wakes the agent with "agent stopped"', () => {
    const w = new CompanyWorld(byId('react-worker-stalls').sim!)
    w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' })
    expect(w.nextWake()!.text).toContain('agent stopped with the card still in In progress')
  })

  test('the loop ends when the work is over and nothing would wake the agent', () => {
    const w = new CompanyWorld(byId('react-worker-stalls').sim!)
    w.handle('heartbeat_configure', { enabled: false })
    expect(w.nextWake()).toBeNull()
  })

  test('wait keeps the real timeout, so it cannot block on hours of work', () => {
    const w = new CompanyWorld(byId('react-worker-stalls').sim!)
    const { task_id } = w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' }) as unknown as { task_id: string }
    expect(w.handle('wait', { task_ids: [task_id], timeout_ms: 3_600_000 })).toMatchObject({ status: 'timeout', waited_sim_hours: 0.17 })
    expect(w.snapshot().now).toBe('2026-10-14T15:10:00.000Z')
  })

  test('a stalled card reads "agent stopped" in task_list', () => {
    const w = new CompanyWorld(byId('react-worker-stalls').sim!)
    w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' })
    w.advance(4)
    expect((w.handle('task_list', {}) as any).tasks.find((t: any) => t.card?.key === 'P0-2')).toMatchObject({ outcome: 'silent', last_update: 'agent stopped with the card still in In progress' })
  })

  test('schedules the agent creates fire as wakes', () => {
    const w = new CompanyWorld(byId('react-worker-stalls').sim!)
    w.handle('heartbeat_configure', { enabled: false })
    expect((w.handle('schedule_create', { name: 'x', prompt: 'check', cron: 'nope' }) as any).error).toMatch(/Invalid cron/)
    w.handle('schedule_create', { name: 'Check-in', prompt: 'Check the board.', cron: '30 * * * *' })
    const wake = w.nextWake()!
    expect(wake).toMatchObject({ kind: 'schedule', at: '2026-10-14T15:30:00.000Z', text: '[Schedule: Check-in] Check the board.' })
  })
})

describe('reactive cases', () => {
  test('a reactive agent passes monitor-phase; reaction is immediate', () => {
    const e = byId('react-monitor-phase')
    const s = play(e, reactive())
    expect(grade(e, s, REACTIVE_REPLY)).toEqual(Object.fromEntries(e.validationCriteria.map((c) => [c.id, true])))
    expect(handoffLags(s)).toEqual([0, 0, 0])
    expect(Math.max(...reactionHours(s))).toBe(0)
  })

  test('an hourly poller fails monitor-phase: polling timer, and the wake budget runs out first', () => {
    const e = byId('react-monitor-phase')
    const s = play(e, poller)
    const g = grade(e, s, POLLING_REPLY)
    expect(pollingTimers(s)).toEqual(['schedule_create 0 * * * *'])
    expect(g['no-polling-timer']).toBe(false)
    expect(g['said-reactive']).toBe(false)
    expect(g['phase-done']).toBe(false)
  })

  test('without platform watching, waiting on the task still reacts at once; the heartbeat alone lags', () => {
    const e = byId('react-monitor-phase-unwatched')
    const waited = play(e, reactive(true))
    expect(grade(e, waited, REACTIVE_REPLY)['reacted-fast']).toBe(true)
    expect(grade(e, waited, REACTIVE_REPLY)['phase-done']).toBe(true)

    const relied = play(e, reactive())
    expect(grade(e, relied, REACTIVE_REPLY)['reacted-fast']).toBe(false)
    expect(Math.min(...handoffLags(relied))).toBeGreaterThanOrEqual(1)
  })

  test('worker-stalls: restarting on the stop update passes', () => {
    const e = byId('react-worker-stalls')
    const s = play(e, (w, wake) => {
      if (wake && /agent stopped/.test(wake.text)) w.handle('work_item_update', { item: 'P0-2', assignee_agent: 'Samsara Engineer' })
      else advancePhase(w)
    })
    expect(grade(e, s, REACTIVE_REPLY)).toEqual(Object.fromEntries(e.validationCriteria.map((c) => [c.id, true])))
  })

  test('explicit-cron: a Monday 9am schedule passes; an hourly one does not', () => {
    const e = byId('react-explicit-cron')
    const weekly = new CompanyWorld(e.sim!)
    weekly.handle('schedule_create', { name: 'Phase 0 digest', prompt: 'Post the digest.', cron: '0 9 * * 1' })
    expect(grade(e, weekly.snapshot(), '')['weekly-schedule']).toBe(true)
    const hourly = new CompanyWorld(e.sim!)
    hourly.handle('schedule_create', { name: 'Phase 0 digest', prompt: 'Post the digest.', cron: '0 * * * 1' })
    expect(grade(e, hourly.snapshot(), '')['weekly-schedule']).toBe(false)
  })

  test('asks-hourly grades the explanation', () => {
    const e = byId('react-asks-hourly')
    const s = new CompanyWorld(e.sim!).snapshot()
    expect(grade(e, s, 'You do not need one: I hear the moment P0-2 lands in Review or the engineer stops, and act right away.')['explains-reactive']).toBe(true)
    expect(grade(e, s, 'Done, hourly check set.')['explains-reactive']).toBe(false)
  })
})
