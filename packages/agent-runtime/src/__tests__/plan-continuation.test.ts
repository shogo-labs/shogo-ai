// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The guards that decide whether a finished turn is actually finished
 * (SHO-121). Every case here is a turn that ended correctly and must not be
 * restarted — each one costs a full model call if it is wrong.
 */
import { describe, expect, test } from 'bun:test'
import {
  PLAN_CONTINUATION_DEFAULT,
  buildPlanContinuationPrompt,
  openPlanItems,
  planContinuationAllowedFor,
  planContinuationLimit,
  shouldContinuePlan,
  type PlanContinuationInput,
  type SessionTodo,
} from '../plan-continuation'

const open: SessionTodo[] = [
  { id: '1', content: 'Write the endpoint', status: 'in_progress' },
  { id: '2', content: 'Add tests', status: 'pending' },
]
const done: SessionTodo[] = [{ id: '1', content: 'Write the endpoint', status: 'completed' }]

const base = (patch: Partial<PlanContinuationInput> = {}): PlanContinuationInput => ({
  turn: { lastStopReason: 'stop', toolCalls: [{ name: 'todo_write' }] },
  open,
  aborted: false,
  pendingWake: false,
  runningTask: false,
  ...patch,
})

describe('planContinuationLimit', () => {
  test('defaults to two passes, 0 disables, junk keeps the default', () => {
    expect(planContinuationLimit(undefined)).toBe(PLAN_CONTINUATION_DEFAULT)
    expect(planContinuationLimit('')).toBe(PLAN_CONTINUATION_DEFAULT)
    expect(planContinuationLimit('0')).toBe(0)
    expect(planContinuationLimit('3')).toBe(3)
    expect(planContinuationLimit('-2')).toBe(0)
    expect(planContinuationLimit('nonsense')).toBe(PLAN_CONTINUATION_DEFAULT)
  })
})

describe('openPlanItems', () => {
  test('keeps pending and in_progress, drops completed', () => {
    expect(openPlanItems([...open, ...done]).map((todo) => todo.id)).toEqual(['1', '2'])
    expect(openPlanItems([])).toEqual([])
    expect(openPlanItems(undefined)).toEqual([])
  })
})

describe('planContinuationAllowedFor', () => {
  test('only a chat turn in agent mode may spend a continuation', () => {
    expect(planContinuationAllowedFor({ isHeartbeat: false, isChannelTurn: false, interactionMode: 'agent' })).toBe(true)
    expect(planContinuationAllowedFor({ isHeartbeat: true, isChannelTurn: false, interactionMode: 'agent' })).toBe(false)
    expect(planContinuationAllowedFor({ isHeartbeat: false, isChannelTurn: true, interactionMode: 'agent' })).toBe(false)
    expect(planContinuationAllowedFor({ isHeartbeat: false, isChannelTurn: false, interactionMode: 'plan' })).toBe(false)
    expect(planContinuationAllowedFor({ isHeartbeat: false, isChannelTurn: false, interactionMode: 'ask' })).toBe(false)
  })
})

describe('shouldContinuePlan', () => {
  test('continues a turn that ended normally with open items', () => {
    expect(shouldContinuePlan(base())).toBe(true)
  })

  test('does not continue when the list is empty', () => {
    expect(shouldContinuePlan(base({ open: [] }))).toBe(false)
  })

  test('does not continue after a failure of any kind', () => {
    for (const turn of [
      { ...base().turn, error: new Error('provider down') },
      { ...base().turn, usageLimit: { resetsAt: '2099-01-01T00:00:00.000Z' } },
      { ...base().turn, loopBreak: { pattern: 'repeat' } },
      { ...base().turn, maxIterationsExhausted: true },
      { ...base().turn, abortReason: 'external' },
    ]) {
      expect(shouldContinuePlan(base({ turn }))).toBe(false)
    }
  })

  test('does not continue a truncated answer', () => {
    expect(shouldContinuePlan(base({ turn: { ...base().turn, lastStopReason: 'length' } }))).toBe(false)
  })

  test('does not continue after handing the user a question', () => {
    expect(shouldContinuePlan(base({ turn: { ...base().turn, toolCalls: [{ name: 'todo_write' }, { name: 'ask_user' }] } }))).toBe(
      false,
    )
  })

  test('does not continue while a stop, a wake or a running task owns the session', () => {
    expect(shouldContinuePlan(base({ aborted: true }))).toBe(false)
    expect(shouldContinuePlan(base({ pendingWake: true }))).toBe(false)
    expect(shouldContinuePlan(base({ runningTask: true }))).toBe(false)
  })
})

describe('buildPlanContinuationPrompt', () => {
  test('names the open items and forbids a status report as the answer', () => {
    const prompt = buildPlanContinuationPrompt(open)
    expect(prompt).toContain("- Write the endpoint (in_progress)")
    expect(prompt).toContain('- Add tests (pending)')
    expect(prompt).toContain('Do not post a status report as the final answer while items are open')
    expect(prompt).toContain('blocked')
  })
})
