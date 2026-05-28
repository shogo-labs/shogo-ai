// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full coverage for src/storage/adapter.ts
 *
 * Drives every branch of the 5 exported symbols:
 *   - isBrowser()
 *   - getDefaultStorageAdapter()
 *   - WebStorageAdapter (constructor + getKey + 4 CRUD methods, all try/catch)
 *   - AsyncStorageAdapter (constructor + getKey + 4 async CRUD methods, all try/catch,
 *     plus the optional `clear()` branch)
 *   - NoOpStorageAdapter (4 no-op methods)
 *   - MemoryStorageAdapter (4 methods backed by Map)
 *
 * Baseline before this file: 26.09% lines / 38.89% funcs (only the
 * module-load NoOp + Memory class skeletons were touched by other
 * tests).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  AsyncStorageAdapter,
  MemoryStorageAdapter,
  NoOpStorageAdapter,
  WebStorageAdapter,
  getDefaultStorageAdapter,
  isBrowser,
} from '../adapter'

// ---------------------------------------------------------------------------
// Helpers — a fake browser window with a switchable localStorage
// ---------------------------------------------------------------------------

interface StorageState {
  data: Map<string, string>
  throwOn: Set<'get' | 'set' | 'remove' | 'key' | 'length'>
}

function installFakeBrowser(state: StorageState) {
  const ls = {
    get length(): number {
      if (state.throwOn.has('length')) throw new Error('length blocked')
      return state.data.size
    },
    key(i: number): string | null {
      if (state.throwOn.has('key')) throw new Error('key blocked')
      return Array.from(state.data.keys())[i] ?? null
    },
    getItem(k: string): string | null {
      if (state.throwOn.has('get')) throw new Error('getItem blocked')
      return state.data.get(k) ?? null
    },
    setItem(k: string, v: string): void {
      if (state.throwOn.has('set')) throw new Error('setItem blocked')
      state.data.set(k, v)
    },
    removeItem(k: string): void {
      if (state.throwOn.has('remove')) throw new Error('removeItem blocked')
      state.data.delete(k)
    },
  }
  ;(globalThis as { window?: unknown }).window = { localStorage: ls }
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
}

function uninstallFakeBrowser() {
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { localStorage?: unknown }).localStorage
}

// ---------------------------------------------------------------------------
// isBrowser / getDefaultStorageAdapter
// ---------------------------------------------------------------------------

describe('isBrowser', () => {
  afterEach(uninstallFakeBrowser)

  test('returns false in Node-like env (no window)', () => {
    expect(isBrowser()).toBe(false)
  })

  test('returns true when window + localStorage are present', () => {
    installFakeBrowser({ data: new Map(), throwOn: new Set() })
    expect(isBrowser()).toBe(true)
  })

  test('returns false when window present but localStorage missing', () => {
    ;(globalThis as { window?: unknown }).window = {} // no localStorage
    expect(isBrowser()).toBe(false)
  })
})

describe('getDefaultStorageAdapter', () => {
  afterEach(uninstallFakeBrowser)

  test('returns NoOpStorageAdapter in Node-like env', () => {
    const a = getDefaultStorageAdapter()
    expect(a).toBeInstanceOf(NoOpStorageAdapter)
  })

  test('returns WebStorageAdapter when window+localStorage present', () => {
    installFakeBrowser({ data: new Map(), throwOn: new Set() })
    const a = getDefaultStorageAdapter()
    expect(a).toBeInstanceOf(WebStorageAdapter)
  })
})

// ---------------------------------------------------------------------------
// WebStorageAdapter
// ---------------------------------------------------------------------------

describe('WebStorageAdapter', () => {
  let state: StorageState
  beforeEach(() => {
    state = { data: new Map(), throwOn: new Set() }
    installFakeBrowser(state)
  })
  afterEach(uninstallFakeBrowser)

  test('default prefix is "shogo_"', () => {
    const a = new WebStorageAdapter()
    a.setItem('x', '1')
    expect(state.data.get('shogo_x')).toBe('1')
  })

  test('custom prefix is honored', () => {
    const a = new WebStorageAdapter('custom_')
    a.setItem('x', '1')
    expect(state.data.get('custom_x')).toBe('1')
  })

  test('getItem returns stored value', () => {
    state.data.set('shogo_a', 'A')
    expect(new WebStorageAdapter().getItem('a')).toBe('A')
  })

  test('getItem returns null when missing', () => {
    expect(new WebStorageAdapter().getItem('missing')).toBeNull()
  })

  test('getItem catches and returns null when localStorage throws', () => {
    state.throwOn.add('get')
    expect(new WebStorageAdapter().getItem('a')).toBeNull()
  })

  test('setItem silently swallows errors', () => {
    state.throwOn.add('set')
    expect(() => new WebStorageAdapter().setItem('a', '1')).not.toThrow()
  })

  test('removeItem deletes the prefixed key', () => {
    state.data.set('shogo_a', 'A')
    new WebStorageAdapter().removeItem('a')
    expect(state.data.has('shogo_a')).toBe(false)
  })

  test('removeItem silently swallows errors', () => {
    state.throwOn.add('remove')
    expect(() => new WebStorageAdapter().removeItem('a')).not.toThrow()
  })

  test('clear() removes only prefixed keys', () => {
    state.data.set('shogo_a', 'A')
    state.data.set('shogo_b', 'B')
    state.data.set('other_c', 'C')
    new WebStorageAdapter().clear()
    expect(state.data.has('shogo_a')).toBe(false)
    expect(state.data.has('shogo_b')).toBe(false)
    expect(state.data.has('other_c')).toBe(true)
  })

  test('clear() skips entries where localStorage.key() returns null', () => {
    state.data.set('shogo_a', 'A')
    // monkey-patch: report length=3 but only 1 real key — index 1 + 2 yield null
    const ls = (globalThis as { localStorage: { length: number; key: (i: number) => string | null } }).localStorage
    Object.defineProperty(ls, 'length', { get: () => 3 })
    const origKey = ls.key.bind(ls)
    ls.key = (i: number) => (i === 0 ? origKey(0) : null)
    new WebStorageAdapter().clear()
    expect(state.data.has('shogo_a')).toBe(false)
  })

  test('clear() silently swallows errors thrown by length/key', () => {
    state.data.set('shogo_a', 'A')
    state.throwOn.add('length')
    expect(() => new WebStorageAdapter().clear()).not.toThrow()
    // value still present because the loop threw before removal
    expect(state.data.has('shogo_a')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AsyncStorageAdapter
// ---------------------------------------------------------------------------

interface FakeAsync {
  store: Map<string, string>
  throwOn: Set<'get' | 'set' | 'remove' | 'clear'>
  hasClear: boolean
}

function makeFakeAsyncStorage(opts: Partial<FakeAsync> = {}): {
  api: ConstructorParameters<typeof AsyncStorageAdapter>[0]
  state: FakeAsync
} {
  const state: FakeAsync = {
    store: opts.store ?? new Map(),
    throwOn: opts.throwOn ?? new Set(),
    hasClear: opts.hasClear ?? true,
  }
  const api: ConstructorParameters<typeof AsyncStorageAdapter>[0] = {
    async getItem(k: string) {
      if (state.throwOn.has('get')) throw new Error('get blocked')
      return state.store.get(k) ?? null
    },
    async setItem(k: string, v: string) {
      if (state.throwOn.has('set')) throw new Error('set blocked')
      state.store.set(k, v)
    },
    async removeItem(k: string) {
      if (state.throwOn.has('remove')) throw new Error('remove blocked')
      state.store.delete(k)
    },
  }
  if (state.hasClear) {
    api.clear = async () => {
      if (state.throwOn.has('clear')) throw new Error('clear blocked')
      state.store.clear()
    }
  }
  return { api, state }
}

describe('AsyncStorageAdapter', () => {
  test('default prefix "shogo_"', async () => {
    const { api, state } = makeFakeAsyncStorage()
    await new AsyncStorageAdapter(api).setItem('x', '1')
    expect(state.store.get('shogo_x')).toBe('1')
  })

  test('custom prefix honored', async () => {
    const { api, state } = makeFakeAsyncStorage()
    await new AsyncStorageAdapter(api, 'rn_').setItem('x', '1')
    expect(state.store.get('rn_x')).toBe('1')
  })

  test('getItem returns stored value (await)', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.store.set('shogo_a', 'A')
    const r = await new AsyncStorageAdapter(api).getItem('a')
    expect(r).toBe('A')
  })

  test('getItem returns null when underlying throws', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.throwOn.add('get')
    const r = await new AsyncStorageAdapter(api).getItem('a')
    expect(r).toBeNull()
  })

  test('setItem silently swallows errors', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.throwOn.add('set')
    await expect(new AsyncStorageAdapter(api).setItem('a', '1')).resolves.toBeUndefined()
  })

  test('removeItem deletes prefixed key', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.store.set('shogo_a', 'A')
    await new AsyncStorageAdapter(api).removeItem('a')
    expect(state.store.has('shogo_a')).toBe(false)
  })

  test('removeItem silently swallows errors', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.throwOn.add('remove')
    await expect(new AsyncStorageAdapter(api).removeItem('a')).resolves.toBeUndefined()
  })

  test('clear() calls underlying clear when present', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.store.set('shogo_a', 'A')
    state.store.set('shogo_b', 'B')
    await new AsyncStorageAdapter(api).clear()
    expect(state.store.size).toBe(0)
  })

  test('clear() silently swallows errors thrown by underlying clear', async () => {
    const { api, state } = makeFakeAsyncStorage()
    state.throwOn.add('clear')
    state.store.set('shogo_a', 'A')
    await expect(new AsyncStorageAdapter(api).clear()).resolves.toBeUndefined()
    expect(state.store.has('shogo_a')).toBe(true) // never cleared
  })

  test('clear() no-ops when underlying has no clear() method', async () => {
    const { api, state } = makeFakeAsyncStorage({ hasClear: false })
    state.store.set('shogo_a', 'A')
    await new AsyncStorageAdapter(api).clear()
    expect(state.store.has('shogo_a')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NoOpStorageAdapter
// ---------------------------------------------------------------------------

describe('NoOpStorageAdapter', () => {
  const a = new NoOpStorageAdapter()

  test('getItem returns null for any key', () => {
    expect(a.getItem('anything')).toBeNull()
  })

  test('setItem is a no-op (no throw)', () => {
    expect(() => a.setItem('k', 'v')).not.toThrow()
  })

  test('removeItem is a no-op', () => {
    expect(() => a.removeItem('k')).not.toThrow()
  })

  test('clear is a no-op', () => {
    expect(() => a.clear()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// MemoryStorageAdapter
// ---------------------------------------------------------------------------

describe('MemoryStorageAdapter', () => {
  let a: MemoryStorageAdapter
  beforeEach(() => {
    a = new MemoryStorageAdapter()
  })

  test('getItem returns null for missing key', () => {
    expect(a.getItem('x')).toBeNull()
  })

  test('setItem + getItem round-trip', () => {
    a.setItem('x', '1')
    expect(a.getItem('x')).toBe('1')
  })

  test('removeItem deletes', () => {
    a.setItem('x', '1')
    a.removeItem('x')
    expect(a.getItem('x')).toBeNull()
  })

  test('clear() removes all entries', () => {
    a.setItem('a', '1')
    a.setItem('b', '2')
    a.clear()
    expect(a.getItem('a')).toBeNull()
    expect(a.getItem('b')).toBeNull()
  })
})
