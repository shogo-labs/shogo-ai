// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the renderer-side OSC 633 tracker.
 *
 * We feed it events that match what the OscDecoder yields and assert
 * the folded Command[] is what the UI would render. No xterm.js — the
 * MarkerFactory is a counting fake.
 */

import { describe, it, expect } from 'bun:test'
import { OscDecoder, type OscEvent } from '@shogo/pty-core'
import {
  Osc633Tracker,
  type MarkerFactory,
  type CommandMarker,
  type TrackerEvent,
} from '../osc633-tracker'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

// ─── helpers ────────────────────────────────────────────────────────────

function feedString(t: Osc633Tracker, s: string): OscEvent[] {
  const r = new OscDecoder().feed(enc(s))
  t.feedAll(r.events)
  return r.events
}

function makeMarkers(): MarkerFactory & { count(): number } {
  let n = 0
  return {
    registerMarker(): CommandMarker { n += 1; return { line: n } },
    count(): number { return n },
  }
}

// ─── happy path ─────────────────────────────────────────────────────────

describe('Osc633Tracker — single command cycle', () => {
  it('A B C D produces one finished command with exit 0', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07')
    feedString(t, '\x1b]633;B\x07')
    feedString(t, '\x1b]633;C\x07')
    feedString(t, '\x1b]633;D;0\x07')
    const { current, commands } = t.snapshot()
    expect(current).toBeNull()
    expect(commands).toHaveLength(1)
    expect(commands[0]!).toMatchObject({
      id: 1,
      exitCode: 0,
      state: 'finished',
    })
    expect(commands[0]!.startedAt).not.toBeNull()
    expect(commands[0]!.finishedAt).not.toBeNull()
  })

  it('captures exit code from D;<n>', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;42\x07')
    expect(t.snapshot().commands[0]!.exitCode).toBe(42)
  })

  it('treats D without an exit arg as null', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D\x07')
    expect(t.snapshot().commands[0]!.exitCode).toBeNull()
  })

  it('treats D with a non-numeric exit arg as null', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;xyz\x07')
    expect(t.snapshot().commands[0]!.exitCode).toBeNull()
  })
})

// ─── multiple commands ─────────────────────────────────────────────────

describe('Osc633Tracker — sequential commands', () => {
  it('echoes back two commands with monotonic ids', () => {
    const t = new Osc633Tracker(makeMarkers())
    // command 1
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    // command 2
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;1\x07')
    const { commands } = t.snapshot()
    expect(commands.map((c) => c.id)).toEqual([1, 2])
    expect(commands.map((c) => c.exitCode)).toEqual([0, 1])
  })

  it('emits command-started + command-finished events to listeners', () => {
    const t = new Osc633Tracker(makeMarkers())
    const seen: TrackerEvent[] = []
    t.on((e) => seen.push(e))
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const kinds = seen.map((e) => e.kind)
    expect(kinds).toEqual(['command-started', 'command-finished'])
  })
})

// ─── Cwd tracking ──────────────────────────────────────────────────────

describe('Osc633Tracker — P;Cwd', () => {
  it('updates the tracker cwd and emits cwd-changed', () => {
    const t = new Osc633Tracker(makeMarkers())
    const seen: TrackerEvent[] = []
    t.on((e) => seen.push(e))
    feedString(t, '\x1b]633;P;Cwd=/tmp\x07\x1b]633;A\x07')
    expect(t.getCurrentCwd()).toBe('/tmp')
    expect(seen[0]).toEqual({ kind: 'cwd-changed', cwd: '/tmp' })
  })

  it('stamps the current cwd on the command at A time, not C time', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;P;Cwd=/tmp\x07')
    feedString(t, '\x1b]633;A\x07')
    // user `cd /var/log` happens — shell emits P;Cwd only at next prompt cycle
    feedString(t, '\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    feedString(t, '\x1b]633;P;Cwd=/var/log\x07\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const { commands } = t.snapshot()
    expect(commands.map((c) => c.cwd)).toEqual(['/tmp', '/var/log'])
  })

  it('ignores P tokens without a key=value', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;P;Cwd\x07')
    expect(t.getCurrentCwd()).toBeNull()
  })
})

// ─── command line capture via E ────────────────────────────────────────

describe('Osc633Tracker — E captures the command line', () => {
  it('stores the command line after B but before D', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07')
    feedString(t, '\x1b]633;E;ls -la /etc\x07')
    feedString(t, '\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(t.snapshot().commands[0]!.commandLine).toBe('ls -la /etc')
  })
})

// ─── robustness ────────────────────────────────────────────────────────

describe('Osc633Tracker — missing / out-of-order marks', () => {
  it('closes a previous running command with exit=null when a new A arrives without D', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07')
    // No D — user smashed ctrl-C and the shell skipped straight to next prompt.
    feedString(t, '\x1b]633;A\x07')
    const { commands } = t.snapshot()
    expect(commands).toHaveLength(1)
    expect(commands[0]!.exitCode).toBeNull()
    expect(commands[0]!.state).toBe('finished')
  })

  it('tolerates a C without a preceding A or B', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(t.snapshot().commands).toHaveLength(1)
    expect(t.snapshot().commands[0]!.exitCode).toBe(0)
  })

  it('tolerates a B without a preceding A', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    expect(t.snapshot().commands).toHaveLength(1)
  })

  it('forwards unknown OSCs and overflow to listeners', () => {
    const t = new Osc633Tracker(makeMarkers())
    const seen: TrackerEvent[] = []
    t.on((e) => seen.push(e))
    t.feed({ kind: 'unknown-osc', ps: '1337', pt: 'CurrentDir=/foo' })
    t.feed({ kind: 'overflow', droppedBytes: 200 })
    expect(seen.map((e) => e.kind)).toEqual(['unknown', 'unknown'])
  })
})

// ─── OSC 133 compatibility ─────────────────────────────────────────────

describe('Osc633Tracker — OSC 133 (FinalTerm)', () => {
  it('drives the same state machine as 633', () => {
    const t = new Osc633Tracker(makeMarkers())
    feedString(t, '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07')
    expect(t.snapshot().commands).toHaveLength(1)
    expect(t.snapshot().commands[0]!.exitCode).toBe(0)
  })
})

// ─── markers ───────────────────────────────────────────────────────────

describe('Osc633Tracker — marker integration', () => {
  it('asks the factory for a marker at A, C, and D', () => {
    const m = makeMarkers()
    const t = new Osc633Tracker(m)
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    // 3 markers requested (A, C, D); B does not request one.
    expect(m.count()).toBe(3)
    const cmd = t.snapshot().commands[0]!
    expect(cmd.promptMarker).not.toBeNull()
    expect(cmd.startMarker).not.toBeNull()
    expect(cmd.endMarker).not.toBeNull()
  })

  it('works with a no-op factory (the default)', () => {
    const t = new Osc633Tracker()
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;0\x07')
    const cmd = t.snapshot().commands[0]!
    expect(cmd.promptMarker).toBeNull()
    expect(cmd.exitCode).toBe(0)
  })

  it('accepts a factory swap mid-stream (xterm mounts late)', () => {
    const t = new Osc633Tracker() // no-op factory
    feedString(t, '\x1b]633;A\x07\x1b]633;B\x07')
    const m = makeMarkers()
    t.setMarkerFactory(m)
    feedString(t, '\x1b]633;C\x07\x1b]633;D;0\x07')
    // We requested markers only after the swap (C, D).
    expect(m.count()).toBe(2)
  })
})

// ─── end-to-end: a realistic session ───────────────────────────────────

describe('Osc633Tracker — realistic session', () => {
  it('echoes the plan-spec scenario: `echo hi; false; cd /tmp` → exits [0,1,0], final cwd /tmp', () => {
    const t = new Osc633Tracker(makeMarkers())
    // initial prompt
    feedString(t, '\x1b]633;P;Cwd=/home/u\x07\x1b]633;A\x07\x1b]633;B\x07')
    // echo hi
    feedString(t, '\x1b]633;C\x07hi\r\n\x1b]633;D;0\x07')
    feedString(t, '\x1b]633;P;Cwd=/home/u\x07\x1b]633;A\x07\x1b]633;B\x07')
    // false
    feedString(t, '\x1b]633;C\x07\x1b]633;D;1\x07')
    feedString(t, '\x1b]633;P;Cwd=/home/u\x07\x1b]633;A\x07\x1b]633;B\x07')
    // cd /tmp
    feedString(t, '\x1b]633;C\x07\x1b]633;D;0\x07')
    feedString(t, '\x1b]633;P;Cwd=/tmp\x07\x1b]633;A\x07\x1b]633;B\x07')

    const { commands, cwd } = t.snapshot()
    expect(commands.map((c) => c.exitCode)).toEqual([0, 1, 0])
    expect(cwd).toBe('/tmp')
  })
})
