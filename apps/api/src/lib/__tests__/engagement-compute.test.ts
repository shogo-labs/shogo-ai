// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  activeDaySet,
  addDays,
  computeEngagement,
  computeRecentWork,
  computeStreaks,
  computeWorkTotals,
  dayRange,
  emptyRaw,
  groupRawByUser,
  makeZoneClock,
  normalizeTimezone,
  resolveActivityWindow,
  startOfZonedDay,
  type RawActivity,
} from '../engagement-compute'

const at = (iso: string) => new Date(iso)

function usage(userId: string, iso: string, extra: Partial<RawActivity['usage'][number]> = {}) {
  return {
    userId,
    projectId: 'p1',
    chatSessionId: 's1',
    createdAt: at(iso),
    tokens: 100,
    model: 'gpt-x',
    costUsd: 0.01,
    ...extra,
  }
}

describe('timezone helpers', () => {
  test('falls back to UTC for invalid zones', () => {
    expect(normalizeTimezone('Not/AZone')).toBe('UTC')
    expect(normalizeTimezone(undefined)).toBe('UTC')
    expect(normalizeTimezone('America/Los_Angeles')).toBe('America/Los_Angeles')
  })

  test('day key follows the local date, not UTC', () => {
    // 03:30 UTC on the 2nd is still the 1st in Los Angeles (UTC-7 in summer).
    const la = makeZoneClock('America/Los_Angeles')
    const utc = makeZoneClock('UTC')
    const d = at('2026-07-02T03:30:00Z')
    expect(utc.dayKey(d)).toBe('2026-07-02')
    expect(la.dayKey(d)).toBe('2026-07-01')
    expect(la.hour(d)).toBe(20)
  })

  test('half-hour offsets bucket correctly', () => {
    // India is UTC+5:30: 18:45 UTC is 00:15 the next day.
    const ist = makeZoneClock('Asia/Kolkata')
    const d = at('2026-07-01T18:45:00Z')
    expect(ist.dayKey(d)).toBe('2026-07-02')
    expect(ist.hour(d)).toBe(0)
  })

  test('addDays and dayRange cross month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(dayRange('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
  })
})

describe('computeStreaks', () => {
  test('counts consecutive days ending today', () => {
    const days = new Set(['2026-07-01', '2026-07-02', '2026-07-03'])
    expect(computeStreaks(days, '2026-07-03')).toEqual({ current: 3, longest: 3 })
  })

  test('streak stays alive when today has no activity yet but yesterday did', () => {
    const days = new Set(['2026-07-01', '2026-07-02'])
    expect(computeStreaks(days, '2026-07-03')).toEqual({ current: 2, longest: 2 })
  })

  test('streak resets after a missed day', () => {
    const days = new Set(['2026-07-01', '2026-07-02'])
    expect(computeStreaks(days, '2026-07-04').current).toBe(0)
    expect(computeStreaks(days, '2026-07-04').longest).toBe(2)
  })

  test('longest streak can be earlier than the current one', () => {
    const days = new Set(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-07-03'])
    expect(computeStreaks(days, '2026-07-03')).toEqual({ current: 1, longest: 4 })
  })

  test('empty activity', () => {
    expect(computeStreaks(new Set(), '2026-07-03')).toEqual({ current: 0, longest: 0 })
  })
})

describe('computeWorkTotals', () => {
  const window = { from: at('2026-07-01T00:00:00Z'), to: at('2026-07-07T23:59:59Z') }
  const clock = makeZoneClock('UTC')

  test('counts every signal and credits approvals as activity', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      usage: [usage('u1', '2026-07-01T10:00:00Z'), usage('u1', '2026-07-01T11:00:00Z', { chatSessionId: 's2', projectId: 'p2' })],
      tools: [
        { userId: 'u1', toolName: 'edit_file', status: 'complete', linesAdded: 10, linesRemoved: 2, chatSessionId: 's3', createdAt: at('2026-07-02T10:00:00Z') },
      ],
      messages: [{ userId: 'u1', createdAt: at('2026-07-03T10:00:00Z') }],
      approvals: [
        { userId: 'u1', decision: 'approved', at: at('2026-07-04T10:00:00Z'), source: 'channel', label: 'Merge PR' },
        { userId: 'u1', decision: 'denied', at: at('2026-07-04T11:00:00Z'), source: 'goal', label: 'Ship it' },
      ],
      tasks: [
        { userId: 'u1', projectId: 'p3', title: 'Write docs', status: 'completed', createdAt: at('2026-07-05T08:00:00Z'), startedAt: at('2026-07-05T09:00:00Z'), completedAt: at('2026-07-05T12:00:00Z'), resultSummary: 'Done' },
      ],
      meetings: [{ userId: 'u1', createdAt: at('2026-07-06T10:00:00Z') }],
    }
    const t = computeWorkTotals(raw, clock, window)
    expect(t).toMatchObject({
      messagesSent: 1,
      approvalsDecided: 2,
      approvalsApproved: 1,
      approvalsDenied: 1,
      tasksStarted: 1,
      tasksCompleted: 1,
      toolCalls: 1,
      linesAdded: 10,
      linesRemoved: 2,
      projectsTouched: 3,
      meetings: 1,
      agentRequests: 2,
      sessions: 3,
      tokens: 200,
      activeDays: 6,
    })
    expect(t.spendUsd).toBeCloseTo(0.02, 5)
    expect(t.lastActiveAt).toBe('2026-07-06T10:00:00.000Z')
  })

  test('a task completed in the window but started before it only counts as completed', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      tasks: [
        { userId: 'u1', projectId: null, title: 'Old task', status: 'completed', createdAt: at('2026-06-20T08:00:00Z'), startedAt: at('2026-06-20T09:00:00Z'), completedAt: at('2026-07-02T12:00:00Z'), resultSummary: null },
      ],
    }
    const t = computeWorkTotals(raw, clock, window)
    expect(t.tasksStarted).toBe(0)
    expect(t.tasksCompleted).toBe(1)
    // The June start day must not leak into active days or streaks.
    expect(t.activeDays).toBe(1)
    expect([...activeDaySet(raw, clock, window)]).toEqual(['2026-07-02'])
  })

  test('a failed task is not counted as completed', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      tasks: [
        { userId: 'u1', projectId: null, title: 'Broken', status: 'failed', createdAt: at('2026-07-02T08:00:00Z'), startedAt: at('2026-07-02T09:00:00Z'), completedAt: at('2026-07-02T10:00:00Z'), resultSummary: null },
      ],
    }
    expect(computeWorkTotals(raw, clock, window).tasksCompleted).toBe(0)
  })
})

describe('groupRawByUser', () => {
  test('splits every signal by person', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      usage: [usage('a', '2026-07-01T10:00:00Z'), usage('b', '2026-07-01T10:00:00Z')],
      messages: [{ userId: 'a', createdAt: at('2026-07-01T10:00:00Z') }],
      approvals: [{ userId: 'b', decision: 'approved', at: at('2026-07-01T10:00:00Z'), source: 'channel', label: 'x' }],
    }
    const grouped = groupRawByUser(raw)
    expect(grouped.get('a')!.usage).toHaveLength(1)
    expect(grouped.get('a')!.messages).toHaveLength(1)
    expect(grouped.get('b')!.approvals).toHaveLength(1)
    expect(grouped.get('b')!.messages).toHaveLength(0)
  })
})

describe('computeEngagement', () => {
  const window = { from: at('2026-07-01T00:00:00Z'), to: at('2026-07-05T23:00:00Z') }

  test('zero-fills days and reports an empty dashboard without NaN', () => {
    const stats = computeEngagement(emptyRaw(), window, 'UTC')
    expect(stats.heatmap.map((h) => h.date)).toEqual([
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
    ])
    expect(stats.heatmap.every((h) => h.count === 0)).toBe(true)
    expect(stats.peakHour).toBeNull()
    expect(stats.streak).toEqual({ current: 0, longest: 0 })
    expect(stats.modelShare).toEqual([])
    expect(stats.hourOfWeek).toHaveLength(7)
  })

  test('peak hour, heatmap and weekday matrix use the requested timezone', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      // 2026-07-02 is a Thursday. 16:00 UTC is 09:00 in Los Angeles.
      usage: [usage('u1', '2026-07-02T16:00:00Z'), usage('u1', '2026-07-02T16:30:00Z'), usage('u1', '2026-07-03T02:00:00Z')],
    }
    const la = computeEngagement(raw, window, 'America/Los_Angeles')
    expect(la.peakHour).toBe(9)
    // 02:00 UTC on the 3rd is 19:00 on the 2nd in Los Angeles, so both land on the 2nd.
    expect(la.heatmap.find((h) => h.date === '2026-07-02')!.count).toBe(3)
    expect(la.hourOfWeek[4][9]).toBe(2)

    const utc = computeEngagement(raw, window, 'UTC')
    expect(utc.heatmap.find((h) => h.date === '2026-07-03')!.count).toBe(1)
  })

  test('model share rolls the tail into Other and sums to roughly 100', () => {
    const models = ['a', 'b', 'c', 'd']
    const raw: RawActivity = {
      ...emptyRaw(),
      usage: models.map((m, i) => usage('u1', '2026-07-02T10:00:00Z', { model: m, tokens: (4 - i) * 100 })),
    }
    const stats = computeEngagement(raw, window, 'UTC', { topModels: 2 })
    expect(stats.modelShare.map((m) => m.model)).toEqual(['a', 'b', 'Other'])
    expect(stats.modelShare.map((m) => m.tokens)).toEqual([400, 300, 300])
    const pct = stats.modelShare.reduce((s, m) => s + m.pct, 0)
    expect(pct).toBeGreaterThan(99.5)
    expect(pct).toBeLessThan(100.5)
    expect(stats.daily.models).toEqual(['a', 'b', 'Other'])
    const day = stats.daily.days.find((d) => d.date === '2026-07-02')!
    expect(day.byModel).toEqual({ a: 400, b: 300, Other: 300 })
    expect(day.total).toBe(1000)
  })

  test('model labels are applied before ranking', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      usage: [usage('u1', '2026-07-02T10:00:00Z', { model: 'uuid-1', tokens: 10 }), usage('u1', '2026-07-02T11:00:00Z', { model: 'uuid-2', tokens: 10 })],
    }
    const stats = computeEngagement(raw, window, 'UTC', {
      modelLabel: () => 'Claude',
    })
    expect(stats.modelShare).toEqual([{ model: 'Claude', tokens: 20, pct: 100 }])
  })

  test('top tools report success rate over finished calls only', () => {
    const tool = (status: string) => ({ userId: 'u1', toolName: 'exec', status, linesAdded: 0, linesRemoved: 0, chatSessionId: 's', createdAt: at('2026-07-02T10:00:00Z') })
    const raw: RawActivity = { ...emptyRaw(), tools: [tool('complete'), tool('complete'), tool('error'), tool('streaming')] }
    const stats = computeEngagement(raw, window, 'UTC')
    expect(stats.topTools).toEqual([{ toolName: 'exec', count: 4, successRate: 0.667 }])
  })

  test('streak is measured in the requested timezone', () => {
    // Two activities 10 hours apart straddle midnight UTC but fall on one LA day.
    const raw: RawActivity = {
      ...emptyRaw(),
      usage: [usage('u1', '2026-07-04T20:00:00Z'), usage('u1', '2026-07-05T06:00:00Z')],
    }
    const w = { from: at('2026-07-01T00:00:00Z'), to: at('2026-07-05T12:00:00Z') }
    expect(computeEngagement(raw, w, 'UTC').streak.longest).toBe(2)
    expect(computeEngagement(raw, w, 'America/Los_Angeles').streak.longest).toBe(1)
  })
})

describe('computeRecentWork', () => {
  test('lists completed tasks and approvals newest first', () => {
    const raw: RawActivity = {
      ...emptyRaw(),
      tasks: [
        { userId: 'u1', projectId: null, title: 'Task A', status: 'completed', createdAt: at('2026-07-01T00:00:00Z'), startedAt: null, completedAt: at('2026-07-01T10:00:00Z'), resultSummary: 'ok' },
        { userId: 'u1', projectId: null, title: 'Task B', status: 'running', createdAt: at('2026-07-01T00:00:00Z'), startedAt: null, completedAt: null, resultSummary: null },
      ],
      approvals: [{ userId: 'u1', decision: 'denied', at: at('2026-07-01T12:00:00Z'), source: 'channel', label: 'Run a command' }],
    }
    const recent = computeRecentWork(raw)
    expect(recent.map((r) => r.label)).toEqual(['Run a command', 'Task A'])
    expect(recent[0].detail).toBe('Denied')
    expect(recent[1].detail).toBe('ok')
  })
})

describe('startOfZonedDay', () => {
  test('is local midnight, expressed as a UTC instant', () => {
    const now = at('2026-07-01T20:00:00Z') // 13:00 on Jul 1 in Los Angeles (PDT, UTC-7)
    expect(startOfZonedDay(now, 'America/Los_Angeles').toISOString()).toBe('2026-07-01T07:00:00.000Z')
    expect(startOfZonedDay(now, 'UTC').toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  test('uses the local date, which can differ from the UTC date', () => {
    // 03:00 UTC on Jul 2 is still Jul 1 evening in Los Angeles.
    expect(startOfZonedDay(at('2026-07-02T03:00:00Z'), 'America/Los_Angeles').toISOString()).toBe('2026-07-01T07:00:00.000Z')
  })

  test('daysAgo steps back whole local days', () => {
    const now = at('2026-07-01T20:00:00Z')
    expect(startOfZonedDay(now, 'America/Los_Angeles', 1).toISOString()).toBe('2026-06-30T07:00:00.000Z')
  })

  test('handles half-hour offsets', () => {
    // Kolkata is UTC+5:30, so local midnight is 18:30 UTC the day before.
    expect(startOfZonedDay(at('2026-07-01T12:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-06-30T18:30:00.000Z')
  })

  test('is correct on both sides of a DST change', () => {
    // US spring-forward is 2026-03-08. Midnight that day is still PST (-8); the next midnight is PDT (-7).
    expect(startOfZonedDay(at('2026-03-08T20:00:00Z'), 'America/Los_Angeles').toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(startOfZonedDay(at('2026-03-09T20:00:00Z'), 'America/Los_Angeles').toISOString()).toBe('2026-03-09T07:00:00.000Z')
    // So the day of the change is only 23 hours long.
    const len = startOfZonedDay(at('2026-03-09T20:00:00Z'), 'America/Los_Angeles').getTime() - startOfZonedDay(at('2026-03-08T20:00:00Z'), 'America/Los_Angeles').getTime()
    expect(len).toBe(23 * 3600_000)
  })

  test('falls back to UTC for a bad zone', () => {
    expect(startOfZonedDay(at('2026-07-01T20:00:00Z'), 'Nope/Zone').toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('resolveActivityWindow', () => {
  const now = at('2026-07-01T20:00:00Z')

  test('defaults to today in the given timezone', () => {
    const w = resolveActivityWindow({ tz: 'America/Los_Angeles' }, now)
    expect(w.label).toBe('today')
    expect(w.from.toISOString()).toBe('2026-07-01T07:00:00.000Z')
    expect(w.to).toEqual(now)
  })

  test('yesterday ends exactly where today starts', () => {
    const w = resolveActivityWindow({ range: 'yesterday', tz: 'America/Los_Angeles' }, now)
    expect(w.from.toISOString()).toBe('2026-06-30T07:00:00.000Z')
    expect(w.to.toISOString()).toBe('2026-07-01T07:00:00.000Z')
  })

  test('rolling ranges', () => {
    expect(resolveActivityWindow({ range: '7d' }, now).from.toISOString()).toBe('2026-06-24T20:00:00.000Z')
    expect(resolveActivityWindow({ range: '30d' }, now).from.toISOString()).toBe('2026-06-01T20:00:00.000Z')
  })

  test('explicit bounds win over a range', () => {
    const w = resolveActivityWindow({ range: 'today', since: '2026-06-01T00:00:00Z', until: '2026-06-02T00:00:00Z' }, now)
    expect(w.label).toBe('custom range')
    expect(w.from.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(w.to.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })

  test('since alone runs to now; an until before since is ignored', () => {
    expect(resolveActivityWindow({ since: '2026-06-30T00:00:00Z' }, now).to).toEqual(now)
    expect(resolveActivityWindow({ since: '2026-06-30T00:00:00Z', until: '2026-06-01T00:00:00Z' }, now).to).toEqual(now)
  })

  test('garbage input falls back to today instead of throwing', () => {
    const w = resolveActivityWindow({ since: 'not a date', range: 'whenever', tz: 'UTC' }, now)
    expect(w.label).toBe('today')
    expect(w.from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
})
