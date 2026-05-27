// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  MemoryFsAdapter,
  SnapshotStore,
  type SessionSnapshot,
} from '../persistence'

// ─── deterministic scheduler ───────────────────────────────────────

interface Clock {
  schedule(cb: () => void, ms: number): number
  cancel(h: number): void
  tick(): void
  pending(): number
}

function makeClock(): Clock {
  const queue: { id: number; cb: () => void; ms: number }[] = []
  let next = 1
  return {
    schedule(cb, ms) { const id = next++; queue.push({ id, cb, ms }); return id },
    cancel(h) {
      const i = queue.findIndex((e) => e.id === h)
      if (i >= 0) queue.splice(i, 1)
    },
    tick() {
      const due = queue.splice(0)
      for (const { cb } of due) cb()
    },
    pending() { return queue.length },
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function makeStore(opts: { clock?: Clock; fs?: MemoryFsAdapter; now?: () => number } = {}): {
  store: SnapshotStore
  clock: Clock
  fs: MemoryFsAdapter
} {
  const clock = opts.clock ?? makeClock()
  const fs = opts.fs ?? new MemoryFsAdapter()
  const store = new SnapshotStore({
    dir: '/data/terminals',
    fs,
    debounceMs: 1000,
    now: opts.now ?? (() => 1_700_000_000_000),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  return { store, clock, fs }
}

function snapInput(over: Partial<Omit<SessionSnapshot, 'version' | 'writtenAt'>> = {}): Omit<SessionSnapshot, 'version' | 'writtenAt'> {
  return {
    id: 'sess-1',
    workspaceHash: 'ws-a',
    cwd: '/tmp',
    shell: '/bin/zsh',
    lastSeq: 100,
    ring: 'hello world',
    ...over,
  }
}

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

// ─── debounce + write ─────────────────────────────────────────────

describe('SnapshotStore — debounced write', () => {
  it('does not write until the debounce window elapses', async () => {
    const { store, clock, fs } = makeStore()
    store.update(snapInput())
    expect(clock.pending()).toBe(1)
    expect(fs.files_().size).toBe(0)
    clock.tick()
    await settle()
    expect(fs.files_().size).toBe(1)
    const path = '/data/terminals/ws-a/sess-1.snap'
    expect(fs.files_().has(path)).toBe(true)
  })

  it('coalesces multiple updates for the same id into one write', async () => {
    const { store, clock, fs } = makeStore()
    store.update(snapInput({ ring: 'a' }))
    store.update(snapInput({ ring: 'ab' }))
    store.update(snapInput({ ring: 'abc' }))
    expect(clock.pending()).toBe(1)
    clock.tick()
    await settle()
    const path = '/data/terminals/ws-a/sess-1.snap'
    const parsed = JSON.parse(fs.files_().get(path)!) as SessionSnapshot
    expect(parsed.ring).toBe('abc')
  })

  it('writes atomically (temp file then rename)', async () => {
    const { store, clock, fs } = makeStore()
    let sawTmp = false
    const origRename = fs.rename.bind(fs)
    fs.rename = async (from, to) => {
      if (from.endsWith('.tmp')) sawTmp = true
      await origRename(from, to)
    }
    store.update(snapInput())
    clock.tick()
    await settle()
    expect(sawTmp).toBe(true)
    // No tmp file lingers after rename
    const tmp = '/data/terminals/ws-a/sess-1.snap.tmp'
    expect(fs.files_().has(tmp)).toBe(false)
  })

  it('stamps writtenAt from the injected clock', async () => {
    let t = 5_000
    const { store, clock, fs } = makeStore({ now: () => t })
    store.update(snapInput())
    t = 6_000 // clock advances between update and write
    clock.tick()
    await settle()
    const path = '/data/terminals/ws-a/sess-1.snap'
    const parsed = JSON.parse(fs.files_().get(path)!) as SessionSnapshot
    // writtenAt is stamped at update() time, not flush time
    expect(parsed.writtenAt).toBe(5_000)
  })

  it('caps ring bytes to maxRingBytes', async () => {
    const fs = new MemoryFsAdapter()
    const clock = makeClock()
    const store = new SnapshotStore({
      dir: '/d', fs, debounceMs: 0, maxRingBytes: 10,
      schedule: clock.schedule, cancel: clock.cancel,
    })
    store.update(snapInput({ ring: '0123456789abcdef' }))
    clock.tick()
    await settle()
    const parsed = JSON.parse(fs.files_().get('/d/ws-a/sess-1.snap')!) as SessionSnapshot
    expect(parsed.ring.length).toBe(10)
    expect(parsed.ring).toBe('6789abcdef') // tail kept
  })
})

// ─── flushAll ─────────────────────────────────────────────────────

describe('SnapshotStore — flushAll', () => {
  it('forces all pending writes synchronously', async () => {
    const { store, clock, fs } = makeStore()
    store.update(snapInput({ id: 's1' }))
    store.update(snapInput({ id: 's2' }))
    store.update(snapInput({ id: 's3' }))
    expect(fs.files_().size).toBe(0)
    await store.flushAll()
    expect(fs.files_().size).toBe(3)
    expect(clock.pending()).toBe(0)
  })

  it('is safe to call when nothing is pending', async () => {
    const { store } = makeStore()
    await store.flushAll()
  })

  it('still works after dispose has been called (idempotent + safe)', async () => {
    const { store, fs } = makeStore()
    store.dispose()
    store.update(snapInput())
    await store.flushAll()
    // post-dispose updates are dropped; no writes expected.
    expect(fs.files_().size).toBe(0)
  })
})

// ─── list + load ──────────────────────────────────────────────────

describe('SnapshotStore — list + load', () => {
  it('lists snapshots in a workspace, most-recent first', async () => {
    let t = 1_000
    const fs = new MemoryFsAdapter()
    const clock = makeClock()
    const store = new SnapshotStore({
      dir: '/d', fs, debounceMs: 0,
      now: () => t,
      schedule: clock.schedule, cancel: clock.cancel,
    })
    store.update(snapInput({ id: 'old' })); clock.tick(); await settle()
    t = 2_000
    store.update(snapInput({ id: 'mid' })); clock.tick(); await settle()
    t = 3_000
    store.update(snapInput({ id: 'new' })); clock.tick(); await settle()
    const list = await store.list('ws-a')
    expect(list.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('isolates workspaces (A never sees B)', async () => {
    const { store, clock, fs } = makeStore()
    store.update(snapInput({ id: 's1', workspaceHash: 'ws-a' }))
    store.update(snapInput({ id: 's2', workspaceHash: 'ws-b' }))
    clock.tick()
    await settle()
    expect((await store.list('ws-a')).map((s) => s.id)).toEqual(['s1'])
    expect((await store.list('ws-b')).map((s) => s.id)).toEqual(['s2'])
    void fs
  })

  it('returns [] for a workspace that has no snapshots', async () => {
    const { store } = makeStore()
    expect(await store.list('ws-empty')).toEqual([])
  })

  it('load returns null for unknown id', async () => {
    const { store } = makeStore()
    expect(await store.load('ws-a', 'missing')).toBeNull()
  })

  it('load returns the snapshot when present', async () => {
    const { store, clock } = makeStore()
    store.update(snapInput({ id: 'x', ring: 'hello' }))
    clock.tick()
    await settle()
    const s = await store.load('ws-a', 'x')
    expect(s).not.toBeNull()
    expect(s!.ring).toBe('hello')
  })

  it('skips tmp files when listing', async () => {
    const fs = new MemoryFsAdapter()
    // Plant a stale tmp file alongside a real snap.
    await fs.writeFile('/d/ws-a/sess-1.snap', JSON.stringify({
      version: 1, id: 'sess-1', workspaceHash: 'ws-a', cwd: '/', shell: '/x',
      lastSeq: 0, ring: '', writtenAt: 1,
    }))
    await fs.writeFile('/d/ws-a/sess-leftover.snap.tmp', 'garbage')
    const clock = makeClock()
    const store = new SnapshotStore({ dir: '/d', fs, debounceMs: 0, schedule: clock.schedule, cancel: clock.cancel })
    const list = await store.list('ws-a')
    expect(list.map((s) => s.id)).toEqual(['sess-1'])
  })

  it('drops snapshots with malformed JSON', async () => {
    const fs = new MemoryFsAdapter()
    await fs.writeFile('/d/ws-a/good.snap', JSON.stringify({
      version: 1, id: 'good', workspaceHash: 'ws-a', cwd: '/', shell: '/x',
      lastSeq: 0, ring: '', writtenAt: 1,
    }))
    await fs.writeFile('/d/ws-a/bad.snap', 'not-json')
    const clock = makeClock()
    const store = new SnapshotStore({ dir: '/d', fs, debounceMs: 0, schedule: clock.schedule, cancel: clock.cancel })
    const list = await store.list('ws-a')
    expect(list.map((s) => s.id)).toEqual(['good'])
  })

  it('drops snapshots with wrong schema version', async () => {
    const fs = new MemoryFsAdapter()
    await fs.writeFile('/d/ws-a/v99.snap', JSON.stringify({
      version: 99, id: 'v99', workspaceHash: 'ws-a', cwd: '/', shell: '/x',
      lastSeq: 0, ring: '', writtenAt: 1,
    }))
    const clock = makeClock()
    const store = new SnapshotStore({ dir: '/d', fs, debounceMs: 0, schedule: clock.schedule, cancel: clock.cancel })
    expect(await store.list('ws-a')).toEqual([])
  })

  it('trims overlong ring on read (defensive)', async () => {
    const fs = new MemoryFsAdapter()
    await fs.writeFile('/d/ws-a/big.snap', JSON.stringify({
      version: 1, id: 'big', workspaceHash: 'ws-a', cwd: '/', shell: '/x',
      lastSeq: 0, ring: '0123456789abcdef', writtenAt: 1,
    }))
    const clock = makeClock()
    const store = new SnapshotStore({
      dir: '/d', fs, debounceMs: 0, maxRingBytes: 8,
      schedule: clock.schedule, cancel: clock.cancel,
    })
    const s = await store.load('ws-a', 'big')
    expect(s!.ring.length).toBe(8)
    expect(s!.ring).toBe('89abcdef')
  })
})

// ─── delete + dispose ─────────────────────────────────────────────

describe('SnapshotStore — delete + dispose', () => {
  it('delete returns true on hit, false on miss', async () => {
    const { store, clock } = makeStore()
    store.update(snapInput({ id: 'x' }))
    clock.tick()
    await settle()
    expect(await store.delete('ws-a', 'x')).toBe(true)
    expect(await store.delete('ws-a', 'x')).toBe(false)
  })

  it('dispose cancels pending timers and silences updates', async () => {
    const { store, clock, fs } = makeStore()
    store.update(snapInput({ id: 'x' }))
    store.dispose()
    expect(clock.pending()).toBe(0)
    clock.tick()
    await settle()
    expect(fs.files_().size).toBe(0)
    // Subsequent updates are no-ops.
    store.update(snapInput({ id: 'y' }))
    await store.flushAll()
    expect(fs.files_().size).toBe(0)
  })

  it('dispose is idempotent', () => {
    const { store } = makeStore()
    store.dispose()
    store.dispose()
  })
})
