// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  __resetRuntimeLogDispatcherForTest,
  getRuntimeLogsSnapshot,
  recordBuildEntry,
  recordCanvasErrorEntry,
  recordConsoleEntry,
  recordRuntimeLogEntry,
  RUNTIME_LOG_RING_CAP,
  subscribeRuntimeLogs,
} from '../runtime-log-dispatcher'

beforeEach(() => {
  __resetRuntimeLogDispatcherForTest()
})

describe('recordRuntimeLogEntry', () => {
  test('stamps a monotonically increasing seq and broadcasts to subscribers', () => {
    const received: number[] = []
    subscribeRuntimeLogs((e) => received.push(e.seq))

    const a = recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'a' })
    const b = recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'b' })
    const c = recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'c' })

    expect(b.seq).toBe(a.seq + 1)
    expect(c.seq).toBe(b.seq + 1)
    expect(received).toEqual([a.seq, b.seq, c.seq])
  })

  test('stamps a default ts when omitted', () => {
    const before = Date.now()
    const e = recordRuntimeLogEntry({ source: 'build', level: 'info', text: 'x' })
    const after = Date.now()
    expect(e.ts).toBeGreaterThanOrEqual(before)
    expect(e.ts).toBeLessThanOrEqual(after)
  })

  test('honors a caller-provided ts', () => {
    const e = recordRuntimeLogEntry({
      source: 'build',
      level: 'info',
      text: 'x',
      ts: 1234567,
    })
    expect(e.ts).toBe(1234567)
  })

  test('a listener throwing does not break others', () => {
    const ok = mock(() => {})
    subscribeRuntimeLogs(() => {
      throw new Error('boom')
    })
    subscribeRuntimeLogs(ok)
    recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'x' })
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('recordConsoleEntry', () => {
  test('default stream is stdout → level=info', () => {
    const e = recordConsoleEntry('hello')
    expect(e.source).toBe('console')
    expect(e.level).toBe('info')
  })

  test('stderr stream upgrades to level=error', () => {
    const e = recordConsoleEntry('something bad', 'stderr')
    expect(e.level).toBe('error')
  })

  test('detects ERROR-class words on stdout when no stream is given', () => {
    expect(recordConsoleEntry('npm ERR! something').level).toBe('error')
    expect(recordConsoleEntry('warning: deprecated').level).toBe('warn')
    expect(recordConsoleEntry('ready in 200ms').level).toBe('info')
  })

  test('does NOT match non-word-boundary "error" inside other words', () => {
    // Plan calls out `\bERR\b` style — we should not mark `terror` as error.
    expect(recordConsoleEntry('mirroring').level).toBe('info')
  })
})

describe('recordBuildEntry', () => {
  test('source=build, default level=info', () => {
    const e = recordBuildEntry('[build] compiled successfully')
    expect(e.source).toBe('build')
    expect(e.level).toBe('info')
  })

  test('explicit error level wins', () => {
    const e = recordBuildEntry('[stderr] tsc error', 'error')
    expect(e.level).toBe('error')
  })
})

describe('recordCanvasErrorEntry', () => {
  test('always stamps level=error and copies surfaceId', () => {
    const e = recordCanvasErrorEntry('Uncaught TypeError', 'surface-42')
    expect(e.source).toBe('canvas-error')
    expect(e.level).toBe('error')
    expect(e.surfaceId).toBe('surface-42')
  })
})

describe('getRuntimeLogsSnapshot', () => {
  test('returns all entries in insertion order', () => {
    recordConsoleEntry('a')
    recordBuildEntry('b')
    recordCanvasErrorEntry('c', 'surface')
    const snap = getRuntimeLogsSnapshot()
    expect(snap.map((e) => e.text)).toEqual(['a', 'b', 'c'])
  })

  test('?since=<seq> returns only entries strictly after the cursor', () => {
    const a = recordConsoleEntry('a')
    recordConsoleEntry('b')
    const after = getRuntimeLogsSnapshot({ since: a.seq })
    expect(after.map((e) => e.text)).toEqual(['b'])
  })

  test('?sources= filters by source', () => {
    recordConsoleEntry('console line')
    recordBuildEntry('build line')
    recordCanvasErrorEntry('canvas line', 'surface')
    const onlyBuild = getRuntimeLogsSnapshot({ sources: ['build'] })
    expect(onlyBuild.map((e) => e.text)).toEqual(['build line'])
    const buildAndCanvas = getRuntimeLogsSnapshot({
      sources: ['build', 'canvas-error'],
    })
    expect(buildAndCanvas.map((e) => e.text)).toEqual([
      'build line',
      'canvas line',
    ])
  })

  test('?limit caps the returned slice to the most recent N', () => {
    for (let i = 0; i < 5; i++) recordConsoleEntry(`line ${i}`)
    const snap = getRuntimeLogsSnapshot({ limit: 2 })
    expect(snap.map((e) => e.text)).toEqual(['line 3', 'line 4'])
  })

  test('returns a fresh array (mutation does not poison the buffer)', () => {
    recordConsoleEntry('a')
    const a = getRuntimeLogsSnapshot()
    a.length = 0
    expect(getRuntimeLogsSnapshot().length).toBe(1)
  })
})

describe('ring buffer cap', () => {
  test(`drops oldest entries past RUNTIME_LOG_RING_CAP=${RUNTIME_LOG_RING_CAP}`, () => {
    for (let i = 0; i < RUNTIME_LOG_RING_CAP + 50; i++) {
      recordConsoleEntry(`line ${i}`)
    }
    const snap = getRuntimeLogsSnapshot()
    expect(snap.length).toBe(RUNTIME_LOG_RING_CAP)
    // The oldest 50 entries were trimmed.
    expect(snap[0]!.text).toBe(`line 50`)
    expect(snap[snap.length - 1]!.text).toBe(`line ${RUNTIME_LOG_RING_CAP + 50 - 1}`)
  })
})

describe('subscribeRuntimeLogs', () => {
  test('returns an unsubscribe function', () => {
    const received: string[] = []
    const unsub = subscribeRuntimeLogs((e) => received.push(e.text))
    recordConsoleEntry('a')
    unsub()
    recordConsoleEntry('b')
    expect(received).toEqual(['a'])
  })
})
