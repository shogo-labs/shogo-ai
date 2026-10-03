// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { parseRemindCommand } from '../chat-remind-parse'

// Wednesday 2026-01-14 15:00 UTC (10:00 in New York).
const NOW = new Date(Date.UTC(2026, 0, 14, 15, 0))

function at(cmd: string, tz = 'UTC') {
  const r = parseRemindCommand(cmd, NOW, tz)
  return r ? { text: r.text, at: r.remindAt.toISOString() } : null
}

describe('parseRemindCommand', () => {
  test('relative durations, before or after the text', () => {
    expect(at('/remind me to review the PR in 2 hours')).toEqual({ text: 'review the PR', at: '2026-01-14T17:00:00.000Z' })
    expect(at('/remind me in 10 min to stretch')).toEqual({ text: 'stretch', at: '2026-01-14T15:10:00.000Z' })
    expect(at('/remind me about lunch in 1d')).toEqual({ text: 'lunch', at: '2026-01-15T15:00:00.000Z' })
  })

  test('clock times roll to tomorrow when already past, in the person’s timezone', () => {
    expect(at('/remind me to call Ada at 4pm')).toEqual({ text: 'call Ada', at: '2026-01-14T16:00:00.000Z' })
    expect(at('/remind me to call Ada at 9am')).toEqual({ text: 'call Ada', at: '2026-01-15T09:00:00.000Z' })
    expect(at('/remind me to call Ada at 11am', 'America/New_York')).toEqual({ text: 'call Ada', at: '2026-01-14T16:00:00.000Z' })
    expect(at('/remind me to stand up at 17:30')).toEqual({ text: 'stand up', at: '2026-01-14T17:30:00.000Z' })
  })

  test('today, tonight, tomorrow, and weekdays', () => {
    expect(at('/remind me tomorrow to send the report')).toEqual({ text: 'send the report', at: '2026-01-15T09:00:00.000Z' })
    expect(at('/remind me to ship tomorrow at 2:15pm', 'America/New_York')).toEqual({ text: 'ship', at: '2026-01-15T19:15:00.000Z' })
    expect(at('/remind me tonight to water plants')).toEqual({ text: 'water plants', at: '2026-01-14T20:00:00.000Z' })
    expect(at('/remind me on friday to demo')).toEqual({ text: 'demo', at: '2026-01-16T09:00:00.000Z' })
    expect(at('/remind me to plan wednesday at 10am')).toEqual({ text: 'plan', at: '2026-01-21T10:00:00.000Z' })
  })

  test('returns null without a time or without text', () => {
    expect(at('/remind me to do the thing')).toBeNull()
    expect(at('/remind me in 5 minutes')).toBeNull()
    expect(at('/remind me in 5 parsecs to fly')).toBeNull()
    expect(at('/remind')).toBeNull()
  })
})
