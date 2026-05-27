// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  MemoryKeyValueStore,
  ProfilesStore,
  type DetectedShell,
  type ShellResolver,
} from '../profiles-store'

const fakeResolver = (shells: DetectedShell[]): ShellResolver => ({
  detect: () => shells.slice(),
})

const DETECTED: DetectedShell[] = [
  { id: 'bash', label: 'bash', shell: '/bin/bash' },
  { id: 'zsh', label: 'zsh', shell: '/bin/zsh' },
]

// ─── first-run auto-detect ─────────────────────────────────────────────

describe('ProfilesStore — first run', () => {
  it('auto-detects shells and seeds the document', () => {
    const storage = new MemoryKeyValueStore()
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    const doc = store.load()
    expect(doc.version).toBe(1)
    expect(doc.profiles.map((p) => p.id)).toEqual(['bash', 'zsh'])
    expect(doc.profiles[0]!.isDefault).toBe(true)
    expect(doc.profiles[1]!.isDefault).toBe(false)
  })

  it('persists the auto-detected doc immediately', () => {
    const storage = new MemoryKeyValueStore()
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    store.load()
    const stored = storage.snapshot()
    const key = Object.keys(stored)[0]!
    const parsed = JSON.parse(stored[key]!) as { profiles: { id: string }[] }
    expect(parsed.profiles.map((p) => p.id)).toEqual(['bash', 'zsh'])
  })

  it('cache is memoised — repeated load() does not re-detect', () => {
    let detectCalls = 0
    const storage = new MemoryKeyValueStore()
    const resolver: ShellResolver = {
      detect: () => { detectCalls++; return DETECTED.slice() },
    }
    const store = new ProfilesStore({ storage, resolver })
    store.load(); store.load(); store.load()
    expect(detectCalls).toBe(1)
  })
})

// ─── load from existing document ───────────────────────────────────────

describe('ProfilesStore — load existing', () => {
  it('reads the persisted document instead of re-detecting', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', JSON.stringify({
      version: 1,
      profiles: [{ id: 'fish', label: 'fish', shell: '/usr/bin/fish', isDefault: true }],
    }))
    let detectCalls = 0
    const store = new ProfilesStore({
      storage,
      resolver: { detect: () => { detectCalls++; return DETECTED.slice() } },
    })
    expect(store.list().map((p) => p.id)).toEqual(['fish'])
    expect(detectCalls).toBe(0)
  })

  it('falls back to auto-detect when the JSON is malformed', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', 'not-json')
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    expect(store.list().map((p) => p.id)).toEqual(['bash', 'zsh'])
  })

  it('falls back to auto-detect when the schema version is wrong', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', JSON.stringify({ version: 99, profiles: [] }))
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    expect(store.list().map((p) => p.id)).toEqual(['bash', 'zsh'])
  })
})

// ─── CRUD ─────────────────────────────────────────────────────────────

describe('ProfilesStore — CRUD', () => {
  it('upsert adds a new profile', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    store.upsert({ id: 'nix', label: 'nix-shell', shell: '/usr/bin/nix-shell' })
    expect(store.list().map((p) => p.id)).toEqual(['bash', 'zsh', 'nix'])
    expect(store.get('nix')!.label).toBe('nix-shell')
  })

  it('upsert replaces an existing profile in-place', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    store.upsert({ id: 'bash', label: 'bash (login)', shell: '/bin/bash', args: ['-l'] })
    expect(store.get('bash')!.label).toBe('bash (login)')
    expect(store.list().map((p) => p.id)).toEqual(['bash', 'zsh'])
  })

  it('remove deletes a profile and re-defaults if needed', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    expect(store.remove('bash')).toBe(true) // was the default
    const doc = store.list()
    expect(doc.map((p) => p.id)).toEqual(['zsh'])
    expect(doc[0]!.isDefault).toBe(true) // zsh promoted
  })

  it('remove of a non-existent id returns false', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    expect(store.remove('missing')).toBe(false)
  })

  it('remove of the last profile re-seeds via the resolver', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    store.remove('bash')
    store.remove('zsh')
    expect(store.list().length).toBeGreaterThan(0)
    expect(store.list().some((p) => p.isDefault)).toBe(true)
  })

  it('setDefault moves the default flag exclusively', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    expect(store.setDefault('zsh')).toBe(true)
    const defaults = store.list().filter((p) => p.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe('zsh')
    expect(store.getDefault()!.id).toBe('zsh')
  })

  it('setDefault for an unknown id returns false', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    expect(store.setDefault('missing')).toBe(false)
    expect(store.getDefault()!.id).toBe('bash')
  })
})

// ─── invariants ───────────────────────────────────────────────────────

describe('ProfilesStore — normalisation', () => {
  it('de-duplicates profiles by id (last write wins)', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', JSON.stringify({
      version: 1,
      profiles: [
        { id: 'bash', label: 'first', shell: '/x', isDefault: true },
        { id: 'bash', label: 'second', shell: '/y', isDefault: false },
      ],
    }))
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('second')
  })

  it('ensures exactly one default when the persisted doc has none', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', JSON.stringify({
      version: 1,
      profiles: [
        { id: 'a', label: 'a', shell: '/a' },
        { id: 'b', label: 'b', shell: '/b' },
      ],
    }))
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    const defaults = store.list().filter((p) => p.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe('a')
  })

  it('collapses multiple defaults down to the first one', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.profiles.v1', JSON.stringify({
      version: 1,
      profiles: [
        { id: 'a', label: 'a', shell: '/a', isDefault: true },
        { id: 'b', label: 'b', shell: '/b', isDefault: true },
      ],
    }))
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    expect(store.list().filter((p) => p.isDefault).map((p) => p.id)).toEqual(['a'])
  })
})

// ─── change listener ─────────────────────────────────────────────────

describe('ProfilesStore — listeners', () => {
  it('fires on upsert, remove, and setDefault', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    const seen: string[][] = []
    store.on((doc) => seen.push(doc.profiles.map((p) => p.id)))
    store.upsert({ id: 'x', label: 'x', shell: '/x' })
    store.setDefault('zsh')
    store.remove('x')
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual(['bash', 'zsh', 'x'])
    expect(seen[2]).toEqual(['bash', 'zsh'])
  })

  it('unsubscribe stops further notifications', () => {
    const store = new ProfilesStore({ resolver: fakeResolver(DETECTED) })
    let count = 0
    const off = store.on(() => count++)
    store.upsert({ id: 'a', label: 'a', shell: '/a' })
    off()
    store.upsert({ id: 'b', label: 'b', shell: '/b' })
    expect(count).toBe(1)
  })
})

// ─── reset ────────────────────────────────────────────────────────────

describe('ProfilesStore — reset', () => {
  it('clears the cached + persisted document', () => {
    const storage = new MemoryKeyValueStore()
    const store = new ProfilesStore({ storage, resolver: fakeResolver(DETECTED) })
    store.upsert({ id: 'extra', label: 'extra', shell: '/x' })
    store.reset()
    expect(storage.snapshot()).toEqual({})
    // After reset, a fresh load() re-detects.
    const doc = store.load()
    expect(doc.profiles.map((p) => p.id)).toEqual(['bash', 'zsh'])
  })
})

// ─── MemoryKeyValueStore ─────────────────────────────────────────────

describe('MemoryKeyValueStore', () => {
  it('round-trips values', () => {
    const kv = new MemoryKeyValueStore()
    expect(kv.get('a')).toBeNull()
    kv.set('a', 'hello')
    expect(kv.get('a')).toBe('hello')
    kv.delete('a')
    expect(kv.get('a')).toBeNull()
  })
})
