// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  SnapshotStore,
  InMemorySnapshotStorage,
  type Snapshot,
} from '../persistence/snapshot-store'

function makeStore(): { store: SnapshotStore; storage: InMemorySnapshotStorage } {
  const storage = new InMemorySnapshotStorage()
  const store = new SnapshotStore({ storage, now: () => 1700000000000 })
  return { store, storage }
}

describe('SnapshotStore.save/load roundtrip', () => {
  it('persists a snapshot and reads it back verbatim', () => {
    const { store } = makeStore()
    const saved = store.save({
      sessionId: 's1',
      cwd: '/home/user',
      activeCommand: 'pnpm test',
      lines: ['hello', 'world'],
    })
    expect(saved.savedAt).toBe(1700000000000)
    expect(saved.v).toBe(1)
    const loaded = store.load('s1')
    expect(loaded).not.toBeNull()
    expect(loaded!.cwd).toBe('/home/user')
    expect(loaded!.lines).toEqual(['hello', 'world'])
    expect(loaded!.activeCommand).toBe('pnpm test')
  })

  it('returns null when the sessionId is unknown', () => {
    const { store } = makeStore()
    expect(store.load('nope')).toBeNull()
  })

  it('returns null for stored JSON that does not look like a snapshot', () => {
    const { store, storage } = makeStore()
    storage.set('shogo:term-snapshot:bad', JSON.stringify({ ohno: true }))
    expect(store.load('bad')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const { store, storage } = makeStore()
    storage.set('shogo:term-snapshot:broken', '{not json')
    expect(store.load('broken')).toBeNull()
  })

  it('returns null when v !== 1 (schema guard)', () => {
    const { store, storage } = makeStore()
    storage.set('shogo:term-snapshot:future', JSON.stringify({
      v: 99, sessionId: 'future', cwd: null, lines: [], activeCommand: null, savedAt: 1,
    } as Snapshot & { v: 99 }))
    expect(store.load('future')).toBeNull()
  })
})

describe('SnapshotStore.save row cap', () => {
  it('trims lines to maxRows by keeping the *tail* (most recent)', () => {
    const storage = new InMemorySnapshotStorage()
    const store = new SnapshotStore({ storage, maxRows: 3, now: () => 1 })
    const saved = store.save({
      sessionId: 's',
      cwd: null,
      activeCommand: null,
      lines: ['a', 'b', 'c', 'd', 'e'],
    })
    expect(saved.lines).toEqual(['c', 'd', 'e'])
    const loaded = store.load('s')
    expect(loaded!.lines).toEqual(['c', 'd', 'e'])
  })

  it('does not trim when lines.length <= maxRows', () => {
    const storage = new InMemorySnapshotStorage()
    const store = new SnapshotStore({ storage, maxRows: 10, now: () => 1 })
    const saved = store.save({ sessionId: 's', cwd: null, activeCommand: null, lines: ['a', 'b'] })
    expect(saved.lines).toEqual(['a', 'b'])
  })

  it('defaults maxRows to 5000', () => {
    const storage = new InMemorySnapshotStorage()
    const store = new SnapshotStore({ storage, now: () => 1 })
    const long = Array.from({ length: 5500 }, (_, i) => `line ${i}`)
    const saved = store.save({ sessionId: 's', cwd: null, activeCommand: null, lines: long })
    expect(saved.lines.length).toBe(5000)
    expect(saved.lines[0]).toBe('line 500')
    expect(saved.lines.at(-1)).toBe('line 5499')
  })
})

describe('SnapshotStore.clear / listSessionIds', () => {
  it('clear() removes the entry', () => {
    const { store } = makeStore()
    store.save({ sessionId: 'gone', cwd: null, activeCommand: null, lines: [] })
    expect(store.load('gone')).not.toBeNull()
    store.clear('gone')
    expect(store.load('gone')).toBeNull()
  })

  it('listSessionIds() returns just the sessionId portion (prefix stripped)', () => {
    const { store } = makeStore()
    store.save({ sessionId: 's-A', cwd: null, activeCommand: null, lines: [] })
    store.save({ sessionId: 's-B', cwd: null, activeCommand: null, lines: [] })
    const ids = store.listSessionIds().sort()
    expect(ids).toEqual(['s-A', 's-B'])
  })

  it('overwriting a sessionId replaces the previous snapshot, not appends', () => {
    const { store } = makeStore()
    store.save({ sessionId: 's', cwd: null, activeCommand: null, lines: ['old'] })
    store.save({ sessionId: 's', cwd: '/new', activeCommand: null, lines: ['new'] })
    expect(store.load('s')!.cwd).toBe('/new')
    expect(store.load('s')!.lines).toEqual(['new'])
  })
})

describe('SnapshotStore namespacing', () => {
  it('honors a custom keyPrefix', () => {
    const storage = new InMemorySnapshotStorage()
    const store = new SnapshotStore({ storage, keyPrefix: 'custom::', now: () => 1 })
    store.save({ sessionId: 'x', cwd: null, activeCommand: null, lines: [] })
    expect(storage.get('custom::x')).not.toBeNull()
    expect(storage.get('shogo:term-snapshot:x')).toBeNull()
  })
})
