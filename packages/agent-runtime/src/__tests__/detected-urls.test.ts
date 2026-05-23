// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the dev-server URL detector. We feed it the kinds of
 * banners frameworks actually print (Vite, Next, Vue CLI, Rails, etc.)
 * and check we pull out the right URL — both single-chunk and split
 * across multiple chunks (a common case under ANSI styling).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ingestChunk,
  getDetectedForSession,
  getMostRecentDetection,
  onDetectedUrl,
  _resetForTests,
} from '../detected-urls'

afterEach(() => {
  _resetForTests()
})

describe('detected-urls', () => {
  test('matches Vite Local: banner with ANSI color codes', () => {
    const vite =
      '\x1B[32m  ➜  \x1B[39m  \x1B[1mLocal:\x1B[22m   \x1B[36mhttp://localhost:5173/\x1B[39m\n'
    const result = ingestChunk('s1', vite)
    expect(result?.url).toBe('http://localhost:5173')
  })

  test('matches Next.js dev banner', () => {
    const next =
      '▲ Next.js 14.2.0\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.10:3000\n'
    const result = ingestChunk('s2', next)
    expect(result?.url).toBe('http://localhost:3000')
  })

  test('matches Rails listening banner', () => {
    const rails = '=> Booting Puma\n=> Listening on http://127.0.0.1:3000\n'
    const result = ingestChunk('s3', rails)
    expect(result?.url).toBe('http://127.0.0.1:3000')
  })

  test('matches Django dev banner', () => {
    const django =
      'Watching for file changes with StatReloader\nStarting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.\n'
    const result = ingestChunk('s4', django)
    expect(result?.url).toBe('http://127.0.0.1:8000')
  })

  test('matches Uvicorn / FastAPI banner', () => {
    const uvicorn = 'INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\n'
    const result = ingestChunk('s5', uvicorn)
    expect(result?.url).toBe('http://127.0.0.1:8000')
  })

  test('handles split chunks (label then URL in separate writes)', () => {
    const session = 'split'
    const first = ingestChunk(session, '\x1B[1mLocal:\x1B[22m   ')
    expect(first).toBeNull()
    const second = ingestChunk(session, '\x1B[36mhttp://localhost:4173/\x1B[39m\n')
    expect(second?.url).toBe('http://localhost:4173')
  })

  test('dedupes identical detections on the same session', () => {
    const banner = 'Local: http://localhost:5173/\n'
    const a = ingestChunk('dedupe', banner)
    // Same banner again (e.g. HMR restart) should return the same record
    const b = ingestChunk('dedupe', banner)
    expect(a?.url).toBe('http://localhost:5173')
    expect(b?.url).toBe(a?.url)
  })

  test('updates most-recent across sessions', () => {
    ingestChunk('a', 'Local: http://localhost:5173/\n')
    ingestChunk('b', 'Local: http://localhost:3000/\n')
    expect(getMostRecentDetection()?.url).toBe('http://localhost:3000')
    expect(getDetectedForSession('a')?.url).toBe('http://localhost:5173')
    expect(getDetectedForSession('b')?.url).toBe('http://localhost:3000')
  })

  test('fires listener exactly once per fresh detection', async () => {
    const events: string[] = []
    const off = onDetectedUrl((d) => events.push(d.url))
    ingestChunk('x', 'Local: http://localhost:5173/\n')
    ingestChunk('x', 'Local: http://localhost:5173/\n') // dupe — no fire
    ingestChunk('x', 'Local: http://localhost:4173/\n') // new — fires
    off()
    expect(events).toEqual(['http://localhost:5173', 'http://localhost:4173'])
  })

  test('ignores unparseable garbage', () => {
    expect(ingestChunk('g', 'random shell output with no urls\n')).toBeNull()
    expect(ingestChunk('g', 'Local: not-a-url\n')).toBeNull()
  })
})

import { listAllDetections, clearDetection } from '../detected-urls'

describe('detected-urls gap coverage', () => {
  afterEach(() => _resetForTests())

  test('DA:105 — normalize catch fires for URL with invalid port', () => {
    expect(ingestChunk('badport', 'Local: http://localhost:abc')).toBeNull()
  })

  test('DA:122 — tail buffer slices when input exceeds TAIL_MAX_BYTES (8KB)', () => {
    const filler = 'x'.repeat(9000)
    expect(ingestChunk('overflow', filler)).toBeNull()
  })

  test('DA:172 — listAllDetections returns sorted detections', () => {
    ingestChunk('a', 'Local: http://localhost:3001')
    ingestChunk('b', 'Local: http://localhost:3002')
    const all = listAllDetections()
    expect(all.length).toBe(2)
    expect(all[0].sessionId).toBe('b')
    expect(all[1].sessionId).toBe('a')
  })

  test('DA:176-178 — clearDetection removes session, lastAny unchanged when different', () => {
    ingestChunk('x', 'Local: http://localhost:4001')
    ingestChunk('y', 'Local: http://localhost:4002')
    clearDetection('x')
    expect(getDetectedForSession('x')).toBeNull()
    expect(getMostRecentDetection()?.sessionId).toBe('y')
  })

  test('DA:179-181 — clearDetection updates lastAny when it matches', () => {
    ingestChunk('p', 'Local: http://localhost:5001')
    ingestChunk('q', 'Local: http://localhost:5002')
    clearDetection('q')
    expect(getMostRecentDetection()?.sessionId).toBe('p')
  })

  test('clearDetection sets lastAny to null when no sessions remain', () => {
    ingestChunk('only', 'Local: http://localhost:6001')
    clearDetection('only')
    expect(getMostRecentDetection()).toBeNull()
  })
})
