// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  __resetRuntimeLogStoreForTest,
  clearProject,
  getCursor,
  getEntries,
  getUnseenErrorCount,
  markAllSeen,
  pushEntries,
  pushEntry,
  RUNTIME_LOG_BUFFER_CAP,
  subscribe,
  type RuntimeLogEntry,
} from '../runtime-log-store'

const PROJECT = 'proj-A'

function makeEntry(overrides: Partial<RuntimeLogEntry> = {}): RuntimeLogEntry {
  return {
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? 'console',
    level: overrides.level ?? 'info',
    text: overrides.text ?? 'line',
    origin: overrides.origin ?? 'sse',
    ...(overrides.surfaceId ? { surfaceId: overrides.surfaceId } : {}),
  }
}

beforeEach(() => {
  __resetRuntimeLogStoreForTest()
})

describe('pushEntry', () => {
  test('appends a single entry and notifies subscribers', () => {
    const cb = mock(() => {})
    subscribe(PROJECT, cb)
    pushEntry(PROJECT, makeEntry({ seq: 1, text: 'hi' }))
    expect(getEntries(PROJECT).map((e) => e.text)).toEqual(['hi'])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('drops entries with seq <= cursor (idempotent for SSE re-delivery)', () => {
    pushEntry(PROJECT, makeEntry({ seq: 5 }))
    pushEntry(PROJECT, makeEntry({ seq: 5, text: 'duplicate' }))
    pushEntry(PROJECT, makeEntry({ seq: 3, text: 'older straggler' }))
    const texts = getEntries(PROJECT).map((e) => e.text)
    expect(texts).toEqual(['line'])
  })

  test('exec entries (origin=exec) bypass the cursor check', () => {
    pushEntry(PROJECT, makeEntry({ seq: 10 }))
    pushEntry(
      PROJECT,
      makeEntry({ seq: 0, origin: 'exec', text: 'chat-derived' }),
    )
    const texts = getEntries(PROJECT).map((e) => e.text)
    expect(texts).toEqual(['line', 'chat-derived'])
  })

  test('error entries bump the unseen counter', () => {
    pushEntry(PROJECT, makeEntry({ seq: 1, level: 'info' }))
    pushEntry(PROJECT, makeEntry({ seq: 2, level: 'error' }))
    pushEntry(PROJECT, makeEntry({ seq: 3, level: 'error' }))
    expect(getUnseenErrorCount(PROJECT)).toBe(2)
  })

  test('updates the cursor to the latest seq seen', () => {
    pushEntry(PROJECT, makeEntry({ seq: 4 }))
    expect(getCursor(PROJECT)).toBe(4)
    pushEntry(PROJECT, makeEntry({ seq: 7 }))
    expect(getCursor(PROJECT)).toBe(7)
  })
})

describe('pushEntries', () => {
  test('appends a batch and notifies once', () => {
    const cb = mock(() => {})
    subscribe(PROJECT, cb)
    pushEntries(PROJECT, [
      makeEntry({ seq: 1, text: 'a' }),
      makeEntry({ seq: 2, text: 'b' }),
    ])
    expect(getEntries(PROJECT).map((e) => e.text)).toEqual(['a', 'b'])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('drops the entire batch when nothing new', () => {
    pushEntry(PROJECT, makeEntry({ seq: 5 }))
    const cb = mock(() => {})
    subscribe(PROJECT, cb)
    pushEntries(PROJECT, [
      makeEntry({ seq: 1 }),
      makeEntry({ seq: 5 }),
    ])
    expect(cb).not.toHaveBeenCalled()
  })

  test('partial batch: keeps the new entries only', () => {
    pushEntry(PROJECT, makeEntry({ seq: 5 }))
    pushEntries(PROJECT, [
      makeEntry({ seq: 4, text: 'stale' }),
      makeEntry({ seq: 6, text: 'fresh' }),
    ])
    expect(getEntries(PROJECT).map((e) => e.text)).toEqual(['line', 'fresh'])
    expect(getCursor(PROJECT)).toBe(6)
  })

  test('error entries in the batch all increment the counter', () => {
    pushEntries(PROJECT, [
      makeEntry({ seq: 1, level: 'error' }),
      makeEntry({ seq: 2, level: 'info' }),
      makeEntry({ seq: 3, level: 'error' }),
    ])
    expect(getUnseenErrorCount(PROJECT)).toBe(2)
  })
})

describe('ring buffer cap', () => {
  test(`drops oldest entries past RUNTIME_LOG_BUFFER_CAP=${RUNTIME_LOG_BUFFER_CAP}`, () => {
    for (let i = 1; i <= RUNTIME_LOG_BUFFER_CAP + 50; i++) {
      pushEntry(PROJECT, makeEntry({ seq: i, text: `e${i}` }))
    }
    const list = getEntries(PROJECT)
    expect(list.length).toBe(RUNTIME_LOG_BUFFER_CAP)
    expect(list[0]!.text).toBe(`e51`)
    expect(list[list.length - 1]!.text).toBe(`e${RUNTIME_LOG_BUFFER_CAP + 50}`)
  })
})

describe('clearProject', () => {
  test('drops all visible entries and resets unseen errors', () => {
    pushEntry(PROJECT, makeEntry({ seq: 1, level: 'error' }))
    expect(getUnseenErrorCount(PROJECT)).toBe(1)
    clearProject(PROJECT)
    expect(getEntries(PROJECT)).toHaveLength(0)
    expect(getUnseenErrorCount(PROJECT)).toBe(0)
  })

  test('PRESERVES the cursor (so subsequent SSE events stay deduped)', () => {
    pushEntry(PROJECT, makeEntry({ seq: 9 }))
    clearProject(PROJECT)
    expect(getCursor(PROJECT)).toBe(9)
    // A re-delivery of seq 9 must still be dropped:
    pushEntry(PROJECT, makeEntry({ seq: 9, text: 'dupe' }))
    expect(getEntries(PROJECT)).toHaveLength(0)
  })

  test('clearing an unknown project is a no-op (no throw)', () => {
    expect(() => clearProject('never-seen')).not.toThrow()
  })
})

describe('markAllSeen', () => {
  test('zeroes the unseen counter and notifies subscribers', () => {
    const cb = mock(() => {})
    subscribe(PROJECT, cb)
    pushEntry(PROJECT, makeEntry({ seq: 1, level: 'error' }))
    cb.mockClear()
    markAllSeen(PROJECT)
    expect(getUnseenErrorCount(PROJECT)).toBe(0)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('does not notify when there are already 0 unseen errors', () => {
    const cb = mock(() => {})
    subscribe(PROJECT, cb)
    markAllSeen(PROJECT)
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('subscribe', () => {
  test('only fires for the matching projectId', () => {
    const a = mock(() => {})
    const b = mock(() => {})
    subscribe('A', a)
    subscribe('B', b)
    pushEntry('A', makeEntry({ seq: 1 }))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  test('returns an unsubscribe handle', () => {
    const cb = mock(() => {})
    const unsub = subscribe(PROJECT, cb)
    pushEntry(PROJECT, makeEntry({ seq: 1 }))
    unsub()
    pushEntry(PROJECT, makeEntry({ seq: 2 }))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('one listener throwing does not break siblings', () => {
    const ok = mock(() => {})
    subscribe(PROJECT, () => {
      throw new Error('boom')
    })
    subscribe(PROJECT, ok)
    pushEntry(PROJECT, makeEntry({ seq: 1 }))
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('getEntries — stable empty reference', () => {
  test('returns the same frozen array for unknown projects', () => {
    const a = getEntries('never-seen')
    const b = getEntries('never-seen-either')
    expect(a).toBe(b)
    expect(a).toHaveLength(0)
  })
})
