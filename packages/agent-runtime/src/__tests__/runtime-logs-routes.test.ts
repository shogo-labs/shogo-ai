// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the `/agent/runtime-logs` and `/agent/runtime-logs/stream`
 * route factory.
 *
 * We mount the factory against a fresh Hono app per test so the
 * dispatcher's in-memory state is the only shared seam — and reset it
 * with `__resetRuntimeLogDispatcherForTest` between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetRuntimeLogDispatcherForTest,
  recordBuildEntry,
  recordCanvasErrorEntry,
  recordConsoleEntry,
  recordRuntimeLogEntry,
  type RuntimeLogEntry,
} from '../runtime-log-dispatcher'
import { parseSources, runtimeLogsRoutes } from '../runtime-logs-routes'

beforeEach(() => {
  __resetRuntimeLogDispatcherForTest()
})

afterEach(() => {
  __resetRuntimeLogDispatcherForTest()
})

describe('parseSources', () => {
  test('returns undefined for empty / unset input', () => {
    expect(parseSources(undefined)).toBeUndefined()
    expect(parseSources(null)).toBeUndefined()
    expect(parseSources('')).toBeUndefined()
  })

  test('splits and trims a comma-separated allow-list', () => {
    expect(parseSources('build, console')).toEqual(['build', 'console'])
  })

  test('drops unknown values', () => {
    expect(parseSources('build,nope,console')).toEqual(['build', 'console'])
    expect(parseSources('only-bogus,also-bogus')).toBeUndefined()
  })
})

describe('GET /agent/runtime-logs', () => {
  test('returns an empty list when nothing has been recorded', async () => {
    const app = runtimeLogsRoutes()
    const res = await app.fetch(new Request('http://x/agent/runtime-logs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries).toEqual([])
  })

  test('returns recorded entries in insertion order', async () => {
    recordConsoleEntry('console-line')
    recordBuildEntry('build-line')
    recordCanvasErrorEntry('canvas-line', 'surface-1')

    const app = runtimeLogsRoutes()
    const res = await app.fetch(new Request('http://x/agent/runtime-logs'))
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries.map((e) => e.text)).toEqual([
      'console-line',
      'build-line',
      'canvas-line',
    ])
  })

  test('?since=<seq> filters to entries strictly after the cursor', async () => {
    const a = recordConsoleEntry('a')
    recordConsoleEntry('b')
    recordConsoleEntry('c')

    const app = runtimeLogsRoutes()
    const res = await app.fetch(
      new Request(`http://x/agent/runtime-logs?since=${a.seq}`),
    )
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries.map((e) => e.text)).toEqual(['b', 'c'])
  })

  test('?sources=build,canvas-error filters to those sources', async () => {
    recordConsoleEntry('console-line')
    recordBuildEntry('build-line')
    recordCanvasErrorEntry('canvas-line', 'surface')

    const app = runtimeLogsRoutes()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs?sources=build,canvas-error'),
    )
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries.map((e) => e.source)).toEqual(['build', 'canvas-error'])
  })

  test('?limit caps the response to the most recent N', async () => {
    for (let i = 0; i < 5; i++) recordConsoleEntry(`line ${i}`)
    const app = runtimeLogsRoutes()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs?limit=2'),
    )
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries.map((e) => e.text)).toEqual(['line 3', 'line 4'])
  })

  test('ignores garbage `since` / `limit` values without erroring', async () => {
    recordConsoleEntry('a')
    const app = runtimeLogsRoutes()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs?since=NaN&limit=banana'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: RuntimeLogEntry[] }
    expect(body.entries).toHaveLength(1)
  })
})

// Helper: read the body of a streaming Response for a fixed window. We
// can't iterate forever because the SSE response stays open until the
// request signal aborts.
async function readSseFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const start = Date.now()
  while (Date.now() - start < ms) {
    const remaining = ms - (Date.now() - start)
    const result = (await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ])) as ReadableStreamReadResult<Uint8Array> | null
    if (!result) break
    if (result.done) break
    buf += decoder.decode(result.value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return buf
}

function parseSseEntries(raw: string): RuntimeLogEntry[] {
  return raw
    .split('\n\n')
    .map((chunk) => {
      const m = chunk.match(/^data: (.+)$/m)
      if (!m) return null
      try {
        return JSON.parse(m[1]!) as RuntimeLogEntry
      } catch {
        return null
      }
    })
    .filter((x): x is RuntimeLogEntry => x !== null)
}

describe('GET /agent/runtime-logs/stream', () => {
  test('emits SSE Content-Type and replays the recent backlog', async () => {
    recordConsoleEntry('backlog-1')
    recordConsoleEntry('backlog-2')

    const app = runtimeLogsRoutes()
    const ctl = new AbortController()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs/stream', {
        signal: ctl.signal,
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')

    const raw = await readSseFor(res, 100)
    ctl.abort()

    const entries = parseSseEntries(raw)
    expect(entries.map((e) => e.text)).toEqual(['backlog-1', 'backlog-2'])
  })

  test('streams new entries pushed after the request opens', async () => {
    const app = runtimeLogsRoutes()
    const ctl = new AbortController()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs/stream', {
        signal: ctl.signal,
      }),
    )

    // Give the route a tick to subscribe before we publish.
    await new Promise((r) => setTimeout(r, 10))
    recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'live-1' })
    recordRuntimeLogEntry({ source: 'console', level: 'info', text: 'live-2' })

    const raw = await readSseFor(res, 150)
    ctl.abort()

    const texts = parseSseEntries(raw).map((e) => e.text)
    expect(texts).toContain('live-1')
    expect(texts).toContain('live-2')
  })

  test('?sources= filters live events to only the requested sources', async () => {
    const app = runtimeLogsRoutes()
    const ctl = new AbortController()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs/stream?sources=build', {
        signal: ctl.signal,
      }),
    )

    await new Promise((r) => setTimeout(r, 10))
    recordConsoleEntry('console-noise')
    recordBuildEntry('build-relevant')
    recordCanvasErrorEntry('canvas-noise', 'surface')

    const raw = await readSseFor(res, 150)
    ctl.abort()

    const sources = parseSseEntries(raw).map((e) => e.source)
    expect(sources).toContain('build')
    expect(sources).not.toContain('console')
    expect(sources).not.toContain('canvas-error')
  })

  test('?since= replays only entries strictly after the cursor', async () => {
    const a = recordConsoleEntry('before-cursor')
    const b = recordConsoleEntry('after-cursor-1')
    const c = recordConsoleEntry('after-cursor-2')

    const app = runtimeLogsRoutes()
    const ctl = new AbortController()
    const res = await app.fetch(
      new Request(`http://x/agent/runtime-logs/stream?since=${a.seq}`, {
        signal: ctl.signal,
      }),
    )
    const raw = await readSseFor(res, 100)
    ctl.abort()

    const seqs = parseSseEntries(raw).map((e) => e.seq)
    expect(seqs).toContain(b.seq)
    expect(seqs).toContain(c.seq)
    expect(seqs).not.toContain(a.seq)
  })

  test('aborting the request unsubscribes (no leaked listeners after close)', async () => {
    const app = runtimeLogsRoutes()
    const ctl = new AbortController()
    const res = await app.fetch(
      new Request('http://x/agent/runtime-logs/stream', {
        signal: ctl.signal,
      }),
    )

    await new Promise((r) => setTimeout(r, 10))
    ctl.abort()
    // Drain the pipe so the stream tears down before we publish.
    await readSseFor(res, 50)

    // After abort, publishing should not throw and no listeners should
    // be invoked. We just exercise the path; the absence of a leaked
    // listener is asserted by it not throwing on enqueue-after-close.
    expect(() => recordConsoleEntry('after-abort')).not.toThrow()
  })
})
