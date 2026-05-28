// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { Osc633Tracker, type MarkerFactory, type CommandMarker } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import {
  describeRunningSummary,
  getRunningSummary,
  installBeforeUnloadGuard,
  type SessionLike,
} from '../background-process-warn'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function feed(t: Osc633Tracker, s: string): void {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
}

function makeMarkers(): MarkerFactory {
  let n = 0
  return { registerMarker(): CommandMarker { n += 1; return { line: n } } }
}

function makeSession(id: string, title?: string): SessionLike & { tracker: Osc633Tracker } {
  return { id, title, tracker: new Osc633Tracker(makeMarkers()) }
}

// ─── getRunningSummary ──────────────────────────────────────────────────

describe('getRunningSummary', () => {
  it('returns hasRunning=false when no sessions have a current command', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(getRunningSummary([s]).hasRunning).toBe(false)
  })

  it('reports a single running command past the minIdleMs threshold', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm run build\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s], { now: () => startedAt + 2_000, minIdleMs: 500 })
    expect(summary.hasRunning).toBe(true)
    expect(summary.reports).toHaveLength(1)
    expect(summary.reports[0]).toMatchObject({
      sessionId: 't1',
      sessionTitle: 'Terminal 1',
      commandLine: 'npm run build',
      state: 'running',
    })
    expect(summary.reports[0]!.elapsedMs).toBe(2000)
  })

  it('filters out commands that have been running for less than minIdleMs', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s], { now: () => startedAt + 100, minIdleMs: 500 })
    expect(summary.hasRunning).toBe(false)
  })

  it('includes "awaiting" state (user typed but did not press Enter)', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07') // awaiting C
    const summary = getRunningSummary([s])
    expect(summary.hasRunning).toBe(true)
    expect(summary.reports[0]!.state).toBe('awaiting')
  })

  it('reports multiple sessions in input order', () => {
    const s1 = makeSession('t1', 'Terminal 1')
    const s2 = makeSession('t2', 'Terminal 2')
    feed(s1.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm test\x07\x1b]633;C\x07')
    feed(s2.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;cargo build\x07\x1b]633;C\x07')
    const t1Start = s1.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s1, s2], { now: () => t1Start + 3_000 })
    expect(summary.reports.map((r) => r.sessionId)).toEqual(['t1', 't2'])
  })

  it('falls back to sessionId as title when title is omitted', () => {
    const s = makeSession('term-abc') // no title
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s], { now: () => startedAt + 1_000 })
    expect(summary.reports[0]!.sessionTitle).toBe('term-abc')
  })

  it('uses "(unknown command)" when E was never received', () => {
    const s = makeSession('t1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s], { now: () => startedAt + 1_000 })
    expect(summary.reports[0]!.commandLine).toBe('(unknown command)')
  })
})

// ─── describeRunningSummary ─────────────────────────────────────────────

describe('describeRunningSummary', () => {
  it('returns an empty string when nothing is running', () => {
    expect(describeRunningSummary({ hasRunning: false, reports: [] })).toBe('')
  })

  it('formats a single running command sentence', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm run build\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s], { now: () => startedAt + 2_000 })
    expect(describeRunningSummary(summary)).toBe(
      "'npm run build' is running in Terminal 1.",
    )
  })

  it('formats multiple running commands', () => {
    const s1 = makeSession('t1', 'Terminal 1')
    const s2 = makeSession('t2', 'Terminal 2')
    feed(s1.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm test\x07\x1b]633;C\x07')
    feed(s2.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;cargo build\x07\x1b]633;C\x07')
    const t1Start = s1.tracker.snapshot().current!.startedAt!
    const summary = getRunningSummary([s1, s2], { now: () => t1Start + 3_000 })
    const msg = describeRunningSummary(summary)
    expect(msg).toContain('2 commands are running')
    expect(msg).toContain("'npm test' in Terminal 1")
    expect(msg).toContain("'cargo build' in Terminal 2")
  })
})

// ─── installBeforeUnloadGuard ───────────────────────────────────────────

describe('installBeforeUnloadGuard', () => {
  it('preventDefault + sets returnValue when something is running', () => {
    const s = makeSession('t1', 'Terminal 1')
    feed(s.tracker, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm test\x07\x1b]633;C\x07')
    const startedAt = s.tracker.snapshot().current!.startedAt!

    let registered: ((ev: BeforeUnloadEvent) => void) | null = null
    const target = {
      addEventListener(_t: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void) { registered = listener },
      removeEventListener(): void { registered = null },
    }
    const unregister = installBeforeUnloadGuard(target, () => [s], { now: () => startedAt + 2_000 })

    let prevented = false
    const ev = {
      preventDefault: () => { prevented = true },
      returnValue: '',
    } as unknown as BeforeUnloadEvent
    registered!(ev)
    expect(prevented).toBe(true)
    expect(ev.returnValue).toContain("'npm test' is running in Terminal 1")

    unregister()
    expect(registered).toBeNull()
  })

  it('does not preventDefault when nothing is running', () => {
    const s = makeSession('t1')
    let registered: ((ev: BeforeUnloadEvent) => void) | null = null
    const target = {
      addEventListener(_t: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void) { registered = listener },
      removeEventListener(): void { registered = null },
    }
    installBeforeUnloadGuard(target, () => [s])

    let prevented = false
    const ev = {
      preventDefault: () => { prevented = true },
      returnValue: '',
    } as unknown as BeforeUnloadEvent
    registered!(ev)
    expect(prevented).toBe(false)
    expect(ev.returnValue).toBe('')
  })
})
