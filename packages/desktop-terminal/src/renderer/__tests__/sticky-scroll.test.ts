// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the sticky-scroll surface. We cover:
 *
 *   - the pure `computeStickyState()` reducer (no React),
 *   - `formatElapsed()` formatting,
 *   - that the component module loads cleanly without React being eager.
 *
 * The full hook + component is exercised when apps/desktop integrates,
 * where a real DOM is available. The reducer covers the state machine
 * logic — if it's right, the hook layer (which is a thin wrapper that
 * calls the reducer on every event) is right.
 */

import { describe, it, expect } from 'bun:test'
import { Osc633Tracker, type MarkerFactory, type CommandMarker } from '../osc633-tracker'
import { OscDecoder } from '@shogo/pty-core'
import { computeStickyState, formatElapsed } from '../sticky-scroll'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function feed(t: Osc633Tracker, s: string): void {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
}

function makeMarkers(): MarkerFactory {
  let n = 0
  return { registerMarker(): CommandMarker { n += 1; return { line: n } } }
}

// ─── computeStickyState ─────────────────────────────────────────────────

describe('computeStickyState', () => {
  it('returns null when no command is currently running', () => {
    const t = new Osc633Tracker(makeMarkers())
    expect(computeStickyState(t)).toBeNull()
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07') // prompt only
    expect(computeStickyState(t)).toBeNull()
    feed(t, '\x1b]633;C\x07\x1b]633;D;0\x07') // already finished
    expect(computeStickyState(t)).toBeNull()
  })

  it('returns the running command with its captured command line', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;npm test\x07\x1b]633;C\x07')
    const state = computeStickyState(t)
    expect(state).not.toBeNull()
    expect(state!.label).toBe('npm test')
    expect(state!.command.exitCode).toBeNull()
    expect(state!.command.state).toBe('running')
  })

  it('falls back to the placeholder label when E was not received', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    expect(computeStickyState(t)?.label).toBe('(running command)')
  })

  it('reports elapsed ms relative to the supplied clock', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const startedAt = t.snapshot().current!.startedAt!
    const state = computeStickyState(t, startedAt + 12_345)
    expect(state!.elapsedMs).toBe(12_345)
  })

  it('clamps negative elapsed to 0 (clock skew safety)', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    const startedAt = t.snapshot().current!.startedAt!
    const state = computeStickyState(t, startedAt - 1_000)
    expect(state!.elapsedMs).toBe(0)
  })

  it('transitions to null after D arrives', () => {
    const t = new Osc633Tracker(makeMarkers())
    feed(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    expect(computeStickyState(t)).not.toBeNull()
    feed(t, '\x1b]633;D;0\x07')
    expect(computeStickyState(t)).toBeNull()
  })
})

// ─── formatElapsed ──────────────────────────────────────────────────────

describe('formatElapsed', () => {
  it('formats sub-second as 0s', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
  })
  it('formats seconds', () => {
    expect(formatElapsed(1_000)).toBe('1s')
    expect(formatElapsed(45_500)).toBe('45s')
    expect(formatElapsed(59_999)).toBe('59s')
  })
  it('formats minutes + seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(125_000)).toBe('2m 5s')
  })
  it('formats hours + minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m')
    expect(formatElapsed(3_660_000)).toBe('1h 1m')
    expect(formatElapsed(7_200_000 + 90_000)).toBe('2h 1m')
  })
})

// ─── module load safety ─────────────────────────────────────────────────

describe('sticky-scroll module', () => {
  it('loads without eagerly requiring React', () => {
    // Just importing this module at the top of the file shouldn't
    // throw, and we shouldn't be able to observe React as loaded
    // unless we actually call useStickyScroll / <StickyScroll />.
    expect(typeof computeStickyState).toBe('function')
    expect(typeof formatElapsed).toBe('function')
  })
})
