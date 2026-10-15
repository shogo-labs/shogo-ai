// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { TASK_LANES, taskDropAction, taskLane } from '../agent-task-board'

describe('agent task board', () => {
  test('every status lands in a lane', () => {
    const lanes = new Set(TASK_LANES.map((l) => l.id))
    for (const status of ['draft', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
      expect(lanes.has(taskLane(status))).toBe(true)
    }
    expect(taskLane('completed')).toBe('done')
    expect(taskLane('cancelled')).toBe('failed')
  })

  test('only starting a draft and cancelling live work are drops', () => {
    expect(taskDropAction('draft', 'queued')).toBe('start')
    expect(taskDropAction('draft', 'running')).toBe('start')
    expect(taskDropAction('running', 'failed')).toBe('cancel')
    expect(taskDropAction('queued', 'failed')).toBe('cancel')
    expect(taskDropAction('completed', 'draft')).toBeNull()
    expect(taskDropAction('running', 'done')).toBeNull()
    expect(taskDropAction('draft', 'draft')).toBeNull()
  })
})
