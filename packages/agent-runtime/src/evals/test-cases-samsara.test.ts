// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { CompanyWorld, type SimWake, type WorldSnapshot } from './company-sim/world'
import { LANES, SAMSARA_EVALS, laneLags, pollingLeftOn } from './test-cases-samsara'
import type { AgentEval, EvalResult } from './types'

const byId = (id: string) => SAMSARA_EVALS.find((e) => e.id === `react-samsara-${id}`)!

function grade(e: AgentEval, sim: WorldSnapshot, responseText: string): Record<string, boolean> {
  const r = { sim, responseText, toolCalls: [] } as unknown as EvalResult
  return Object.fromEntries(e.validationCriteria.map((c) => [c.id, c.validate(r)]))
}

/** The runner's wake loop with a scripted agent standing in for the model. */
function play(e: AgentEval, turn: (w: CompanyWorld, wake: SimWake | null) => void): WorldSnapshot {
  const w = new CompanyWorld(e.sim!)
  turn(w, null)
  for (let n = 0; n < (e.sim!.wakes?.maxWakes ?? 0); n++) {
    const wake = w.nextWake()
    if (!wake) break
    turn(w, wake)
  }
  return w.snapshot()
}

/** Close what is in Review and give each idle lane its next card. */
function runLanes(w: CompanyWorld): void {
  for (const i of w.snapshot().items.filter((x) => x.column === 'Review')) w.handle('work_item_move', { item: i.key, column: 'Done' })
  for (const [lane, engineer] of [[LANES.backend, 'Samsara Backend Engineer'], [LANES.ue, 'Samsara UE Engineer']] as const) {
    const s = w.snapshot()
    if (lane.some((c) => s.items.find((i) => i.key === c.key)!.column === 'In progress')) continue
    const next = lane.find((c) => s.items.find((i) => i.key === c.key)!.column === 'Backlog')
    if (next) w.handle('work_item_update', { item: next.key, assignee_agent: engineer })
  }
}

const RULE = '@Samsara Backend Engineer @Samsara UE Engineer when you finish a card, move it to Review with the evidence and tag me.'

describe('samsara: tag-me', () => {
  test('an agent that drops the hourly loop and reacts to each update passes', () => {
    const e = byId('tag-me')
    const s = play(e, (w, wake) => {
      if (!wake) {
        w.handle('team_chat_post', { channel: 'samsara-phase1', text: RULE })
        w.handle('schedule_delete', { scheduleId: 'Samsara Phase 1 loop' })
      }
      runLanes(w)
    })
    expect(pollingLeftOn(s)).toEqual([])
    expect(laneLags(s).length).toBeGreaterThanOrEqual(2)
    expect(grade(e, s, 'Done. Both will tag me, and I hear the moment a card reaches Review anyway, so I turned off the hourly loop.'))
      .toEqual({ 'told-both': true, 'hourly-loop-off': true, 'no-timer-reviews': true, 'reacted-fast': true, 'said-reactive': true })
  })

  test('keeping the hourly loop "as a backstop" (what production did) fails the timer criteria', () => {
    const e = byId('tag-me')
    const s = play(e, (w, wake) => {
      if (!wake) w.handle('team_chat_post', { channel: 'samsara-phase1', text: RULE })
      runLanes(w)
    })
    const g = grade(e, s, 'Both engineers saved the rule. The hourly loop stays on in case a tag gets missed.')
    expect(g['hourly-loop-off']).toBe(false)
    expect(g['no-timer-reviews']).toBe(false)
    expect(g['said-reactive']).toBe(false)
  })
})

describe('samsara: tags that need nothing', () => {
  test('fold-update: close P1-7 and hand P1-8 on; a thank-you tag fails', () => {
    const e = byId('fold-update')
    const w = new CompanyWorld(e.sim!)
    w.handle('work_item_move', { item: 'P1-7', column: 'Done' })
    w.handle('work_item_update', { item: 'P1-8', assignee_agent: 'Samsara UE Engineer' })
    const good = grade(e, w.snapshot(), 'Closed P1-7 (evidence checks out) and handed P1-8 to Samsara UE Engineer.')
    expect(good).toEqual({ reviewed: true, 'lane-moved': true, 'no-thanks-tag': true, 'backend-untouched': true })
    w.handle('team_chat_post', { channel: 'samsara-phase1', text: 'Thanks @Samsara UE Engineer, great work!' })
    expect(grade(e, w.snapshot(), '')['no-thanks-tag']).toBe(false)
  })

  test('ack: a one-line reply passes; tagging the engineer back fails', () => {
    const e = byId('ack')
    const w = new CompanyWorld(e.sim!)
    expect(grade(e, w.snapshot(), 'Noted, both rules saved.')).toEqual({ 'no-tag-back': true, 'no-board-changes': true, brief: true })
    expect(grade(e, w.snapshot(), 'Thanks @Samsara Backend Engineer!')['no-tag-back']).toBe(false)
  })

  test('stuck: asking Russell passes; a third bounce fails', () => {
    const e = byId('stuck')
    const w = new CompanyWorld(e.sim!)
    expect(grade(e, w.snapshot(), '@Russell P1-7 has come back twice with the same wrong citation (:584). Should I close it with the fix noted?'))
      .toEqual({ 'no-third-bounce': true, escalated: true })
    w.handle('work_item_move', { item: 'P1-7', column: 'In progress' })
    w.handle('work_item_comment', { item: 'P1-7', text: '@Samsara UE Engineer still :584, please fix to :586.' })
    expect(grade(e, w.snapshot(), '')['no-third-bounce']).toBe(false)
  })

  test('restart: tagging both engineers resumes both runs', () => {
    const e = byId('restart')
    const w = new CompanyWorld(e.sim!)
    w.handle('team_chat_post', { channel: 'samsara-phase1', text: '@Samsara Backend Engineer resume P1-4. @Samsara UE Engineer resume P1-7.' })
    expect(grade(e, w.snapshot(), 'Both are back on their cards.')).toEqual({ 'both-resumed': true, 'no-new-polling': true, 'few-posts': true })
  })
})
