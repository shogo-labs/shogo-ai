// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'vitest'
import { isApprovalPending, parseGoalDeliverables, parseGoalPlan } from '../types'

describe('isApprovalPending', () => {
  it('is true for an unresolved approval goal event', () => {
    expect(isApprovalPending({ type: 'goal_event', kind: 'approval', metadata: null })).toBe(true)
    expect(isApprovalPending({ type: 'goal_event', kind: 'approval' })).toBe(true)
  })

  it('is false once metadata.resolvedAt is stamped', () => {
    expect(
      isApprovalPending({
        type: 'goal_event',
        kind: 'approval',
        metadata: { resolvedAt: '2026-01-01T00:00:00.000Z' },
      }),
    ).toBe(false)
  })

  it('is false for non-approval goal events and agent_task items', () => {
    expect(isApprovalPending({ type: 'goal_event', kind: 'progress', metadata: null })).toBe(false)
    expect(isApprovalPending({ type: 'agent_task', metadata: null })).toBe(false)
  })
})

describe('parseGoalPlan', () => {
  it('accepts plain string steps', () => {
    expect(parseGoalPlan(['Book flights', 'Pack bags'])).toEqual([
      { title: 'Book flights' },
      { title: 'Pack bags' },
    ])
  })

  it('accepts object steps with done/detail', () => {
    expect(parseGoalPlan([{ title: 'Run 5k', done: true, detail: 'Tuesdays' }])).toEqual([
      { title: 'Run 5k', done: true, detail: 'Tuesdays' },
    ])
  })

  it('skips malformed entries and returns [] for non-array input', () => {
    expect(parseGoalPlan([{ notATitle: 1 }, 42, null])).toEqual([])
    expect(parseGoalPlan(null)).toEqual([])
    expect(parseGoalPlan('not an array')).toEqual([])
  })
})

describe('parseGoalDeliverables', () => {
  it('parses url/file/project deliverables, defaulting unknown type to url', () => {
    expect(
      parseGoalDeliverables([
        { type: 'project', title: 'Habit tracker app', projectId: 'proj-1' },
        { title: 'Training plan doc', url: 'https://example.com/plan.pdf' },
        { type: 'bogus', title: 'Weird one' },
      ]),
    ).toEqual([
      { type: 'project', title: 'Habit tracker app', url: undefined, projectId: 'proj-1', description: undefined },
      { type: 'url', title: 'Training plan doc', url: 'https://example.com/plan.pdf', projectId: undefined, description: undefined },
      { type: 'url', title: 'Weird one', url: undefined, projectId: undefined, description: undefined },
    ])
  })

  it('returns [] for non-array or non-object entries', () => {
    expect(parseGoalDeliverables(null)).toEqual([])
    expect(parseGoalDeliverables(['just a string'])).toEqual([])
  })
})
