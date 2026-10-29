// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "At no point are both enabled" is an ordering contract, not a state that can
 * be checked afterwards — so the test records the call order and asserts it.
 */

import { describe, expect, test } from 'bun:test'
import { buildHandover, readHandover, switchBack, switchOver, type HandoverSides } from '../handover'

const rows = new Map([
  [
    'AgentSchedule',
    [
      { id: 's1', name: 'Morning digest', enabled: true },
      { id: 's2', name: 'Nightly sync', enabled: false },
    ],
  ],
  [
    'EventSubscription',
    [{ id: 't1', name: 'New member card', enabled: true }],
  ],
])

function recorder() {
  const calls: string[] = []
  const sides: HandoverSides = {
    source: {
      setEnabled: async (input) => {
        calls.push(`source:${input.kind}:${input.enabled ? 'on' : 'off'}:${input.ids.join(',')}`)
      },
      markMoved: async (target) => {
        calls.push(`source:mark:${target ?? 'none'}`)
      },
    },
    target: {
      setEnabled: async (input) => {
        calls.push(`target:${input.kind}:${input.enabled ? 'on' : 'off'}:${input.ids.join(',')}`)
      },
    },
  }
  return { calls, sides }
}

describe('buildHandover', () => {
  test('remembers which rows were on at the source', () => {
    const state = buildHandover('move-1', rows)
    expect(state.schedules.map((row) => row.enabled)).toEqual([true, false])
    expect(state.triggers.map((row) => row.enabled)).toEqual([true])
    expect(state.schedules[0]?.targetId).toHaveLength(36)
  })
})

describe('switchOver', () => {
  test('quiets the source before waking the target, and only wakes what was on', async () => {
    const state = buildHandover('move-1', rows)
    const { calls, sides } = recorder()
    await switchOver(sides, state, 'ws-target')

    const sourceOff = calls.findIndex((call) => call.startsWith('source:schedule:off'))
    const targetOn = calls.findIndex((call) => call.startsWith('target:schedule:on'))
    expect(sourceOff).toBeGreaterThanOrEqual(0)
    expect(targetOn).toBeGreaterThan(sourceOff)

    // s2 was already off at the source, so it is never enabled at the target.
    const targetSchedules = calls.find((call) => call.startsWith('target:schedule:on'))
    expect(targetSchedules).not.toContain(state.schedules[1]!.targetId)
    expect(calls).toContain('source:mark:ws-target')
  })

  test('the source is kept: nothing is deleted or renamed', async () => {
    const state = buildHandover('move-1', rows)
    const { calls, sides } = recorder()
    await switchOver(sides, state, 'ws-target')
    expect(calls.every((call) => !call.includes('delete'))).toBe(true)
    expect(calls).toContain('source:mark:ws-target')
  })
})

describe('switchBack', () => {
  test('quiets the target first, then restores the source state', async () => {
    const state = buildHandover('move-1', rows)
    const { calls, sides } = recorder()
    await switchBack(sides, state)

    const targetOff = calls.findIndex((call) => call.startsWith('target:schedule:off'))
    const sourceOn = calls.findIndex((call) => call.startsWith('source:schedule:on'))
    expect(targetOff).toBeGreaterThanOrEqual(0)
    expect(sourceOn).toBeGreaterThan(targetOff)
    expect(calls).toContain('source:mark:none')

    // Only the row that was on before is turned back on.
    const restored = calls.find((call) => call.startsWith('source:schedule:on'))
    expect(restored).toContain('s1')
    expect(restored).not.toContain('s2')
  })
})

describe('readHandover', () => {
  test('a workspace with no automations reads as two empty row sets', () => {
    // The shape SQLite actually hands back: an empty array does not survive the
    // Json round trip and arrives as the string "[]". Trusting it crashed the
    // handover phase on `.map`, after every byte had already copied.
    const fromSqlite = { schedules: '[]', triggers: '[]' }
    const state = readHandover(fromSqlite)
    expect(state.schedules).toEqual([])
    expect(state.triggers).toEqual([])
    expect(() => state.schedules.map((row) => row.targetId)).not.toThrow()
  })

  test('a real array is passed through untouched', () => {
    const state = buildHandover('move-1', rows)
    expect(readHandover(state)).toEqual(state)
  })

  test('one empty side does not disturb the other', () => {
    const state = readHandover({ schedules: '[]', triggers: [{ targetId: 't1', sourceId: 's1', name: 'x', enabled: true }] })
    expect(state.schedules).toEqual([])
    expect(state.triggers.map((row) => row.targetId)).toEqual(['t1'])
  })

  test('a missing row (a move created before the column was written) is empty, not a crash', () => {
    expect(readHandover(null)).toEqual({ schedules: [], triggers: [] })
    expect(readHandover(undefined)).toEqual({ schedules: [], triggers: [] })
    expect(readHandover({})).toEqual({ schedules: [], triggers: [] })
  })

  test('junk in the column is ignored rather than thrown', () => {
    expect(readHandover({ schedules: 'not json', triggers: 42 })).toEqual({ schedules: [], triggers: [] })
  })

  test('switchedOverAt survives the read', () => {
    expect(readHandover({ schedules: '[]', triggers: '[]', switchedOverAt: '2026-10-29T00:00:00.000Z' }).switchedOverAt).toBe(
      '2026-10-29T00:00:00.000Z',
    )
  })
})
