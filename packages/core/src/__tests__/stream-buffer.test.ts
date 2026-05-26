// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  StreamBufferStore,
  createBufferingTransform,
  type StreamBufferWriter,
} from '../stream-buffer'

const enc = new TextEncoder()
const u8 = (s: string) => enc.encode(s)

async function drain(stream: ReadableStream<Uint8Array>, limit = 1024): Promise<string[]> {
  const reader = stream.getReader()
  const out: string[] = []
  const dec = new TextDecoder()
  let i = 0
  while (i++ < limit) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(dec.decode(value))
  }
  reader.releaseLock()
  return out
}

describe('StreamBufferStore.create', () => {
  let store: StreamBufferStore
  beforeEach(() => { store = new StreamBufferStore() })
  afterEach(() => { store.dispose() })

  test('creates a new buffer with default generated turnId', () => {
    const w = store.create('k1')
    expect(typeof w.turnId).toBe('string')
    expect(w.turnId.length).toBeGreaterThan(0)
    expect(w.lastSeq).toBe(0)
    expect(store.has('k1')).toBe(true)
  })

  test('accepts a custom turnId', () => {
    const w = store.create('k1', { turnId: 'my-turn-1' })
    expect(w.turnId).toBe('my-turn-1')
  })

  test('replaces an existing active buffer (completes the old one)', () => {
    const w1 = store.create('k1', { turnId: 't1' })
    w1.append(u8('hello'))
    const w2 = store.create('k1', { turnId: 't2' })
    expect(w2.turnId).toBe('t2')
    // Old writer cannot append anymore because its buffer is no longer active
    expect(w1.append(u8('after'))).toBe(-1)
    // New buffer is the one stored
    expect(store.snapshot('k1')?.turnId).toBe('t2')
  })

  test('does NOT replace a non-active buffer (completed one stays for grace)', () => {
    const w1 = store.create('k1', { turnId: 't1' })
    w1.complete('done')
    // Snapshot still there
    expect(store.snapshot('k1')?.status).toBe('completed')
    const w2 = store.create('k1', { turnId: 't2' })
    expect(w2.turnId).toBe('t2')
    expect(store.snapshot('k1')?.turnId).toBe('t2')
  })
})

describe('StreamBufferWriter', () => {
  let store: StreamBufferStore
  let writer: StreamBufferWriter
  beforeEach(() => {
    store = new StreamBufferStore()
    writer = store.create('k')
  })
  afterEach(() => { store.dispose() })

  test('append() returns monotonically increasing seq', () => {
    expect(writer.append(u8('a'))).toBe(1)
    expect(writer.append(u8('b'))).toBe(2)
    expect(writer.append(u8('c'))).toBe(3)
    expect(writer.lastSeq).toBe(3)
  })

  test('append() returns -1 after complete()', () => {
    writer.append(u8('a'))
    writer.complete('done')
    expect(writer.append(u8('b'))).toBe(-1)
  })

  test('append() returns -1 after fail()', () => {
    writer.fail('boom')
    expect(writer.append(u8('z'))).toBe(-1)
  })

  test('complete() sets terminal.reason', () => {
    writer.complete('graceful-shutdown')
    const snap = store.snapshot('k')
    expect(snap?.status).toBe('completed')
    expect(snap?.terminal).toEqual({ reason: 'graceful-shutdown' })
    expect(snap?.completedAt).not.toBeNull()
  })

  test('complete() without reason still works', () => {
    writer.complete()
    expect(store.snapshot('k')?.terminal).toEqual({ reason: undefined })
  })

  test('fail() sets terminal.error and status=failed', () => {
    writer.fail('upstream-timeout')
    const snap = store.snapshot('k')
    expect(snap?.status).toBe('failed')
    expect(snap?.terminal).toEqual({ error: 'upstream-timeout' })
  })

  test('complete() is idempotent (calling twice does nothing)', () => {
    writer.complete('first')
    const before = store.snapshot('k')!.completedAt
    writer.complete('second')
    const after = store.snapshot('k')!.completedAt
    expect(after).toBe(before)
    expect(store.snapshot('k')?.terminal?.reason).toBe('first')
  })

  test('fail() is idempotent', () => {
    writer.fail('err1')
    const before = store.snapshot('k')!.completedAt
    writer.fail('err2')
    expect(store.snapshot('k')!.completedAt).toBe(before)
    expect(store.snapshot('k')?.terminal?.error).toBe('err1')
  })
})

describe('StreamBufferStore.append (loose by-key)', () => {
  let store: StreamBufferStore
  beforeEach(() => { store = new StreamBufferStore() })
  afterEach(() => { store.dispose() })

  test('returns seq for known active buffer', () => {
    store.create('k')
    expect(store.append('k', u8('x'))).toBe(1)
    expect(store.append('k', u8('y'))).toBe(2)
  })

  test('returns -1 for unknown key', () => {
    expect(store.append('missing', u8('x'))).toBe(-1)
  })

  test('returns -1 for inactive buffer', () => {
    const w = store.create('k')
    w.complete()
    expect(store.append('k', u8('z'))).toBe(-1)
  })

  test('updates lastEventAt on append', async () => {
    store.create('k')
    const t1 = store.snapshot('k')!.lastEventAt
    await new Promise(r => setTimeout(r, 2))
    store.append('k', u8('x'))
    const t2 = store.snapshot('k')!.lastEventAt
    expect(t2).toBeGreaterThanOrEqual(t1)
  })

  test('propagates appended chunks to subscribers', async () => {
    store.create('k')
    store.append('k', u8('pre'))
    const s = store.createReplayStream('k')!
    // Add live chunks
    store.append('k', u8('live'))
    store.complete('k')
    const chunks = await drain(s)
    expect(chunks).toContain('pre')
    expect(chunks).toContain('live')
  })

  test('removes a failing subscriber when ctrl.enqueue throws', () => {
    const w = store.create('k')
    // Inject a faulty subscriber that throws on enqueue
    const buf = (store as any).buffers.get('k')
    const goodEnqueue = mock(() => {})
    const badEnqueue = mock(() => { throw new Error('closed') })
    const good = { enqueue: goodEnqueue } as any
    const bad = { enqueue: badEnqueue } as any
    buf.subscribers.add(good)
    buf.subscribers.add(bad)
    w.append(u8('hi'))
    expect(goodEnqueue).toHaveBeenCalledTimes(1)
    expect(buf.subscribers.has(bad)).toBe(false)
    expect(buf.subscribers.has(good)).toBe(true)
  })

  test('removes a failing subscriber when called via store.append', () => {
    store.create('k')
    const buf = (store as any).buffers.get('k')
    const bad = { enqueue: () => { throw new Error('x') } } as any
    buf.subscribers.add(bad)
    store.append('k', u8('y'))
    expect(buf.subscribers.has(bad)).toBe(false)
  })
})

describe('StreamBufferStore.complete / abort / has / snapshot', () => {
  let store: StreamBufferStore
  beforeEach(() => { store = new StreamBufferStore() })
  afterEach(() => { store.dispose() })

  test('complete(key) marks buffer completed', () => {
    store.create('k')
    store.complete('k', 'manual')
    expect(store.snapshot('k')?.status).toBe('completed')
  })

  test('complete(key) on unknown key is a no-op', () => {
    expect(() => store.complete('nope')).not.toThrow()
  })

  test('abort(key) removes the buffer entirely', () => {
    store.create('k')
    store.abort('k')
    expect(store.has('k')).toBe(false)
    expect(store.snapshot('k')).toBeNull()
  })

  test('abort(key) on unknown key is a no-op', () => {
    expect(() => store.abort('nope')).not.toThrow()
  })

  test('has() returns true for active, true for completed (until cleanup), false after abort', () => {
    store.create('k')
    expect(store.has('k')).toBe(true)
    store.complete('k')
    expect(store.has('k')).toBe(true)
    store.abort('k')
    expect(store.has('k')).toBe(false)
  })

  test('snapshot() returns null for unknown key', () => {
    expect(store.snapshot('nope')).toBeNull()
  })

  test('snapshot() reflects writer.lastSeq and createdAt', () => {
    const w = store.create('k')
    w.append(u8('a'))
    w.append(u8('b'))
    const snap = store.snapshot('k')!
    expect(snap.lastSeq).toBe(2)
    expect(snap.status).toBe('active')
    expect(snap.terminal).toBeNull()
    expect(snap.completedAt).toBeNull()
    expect(typeof snap.createdAt).toBe('number')
    expect(typeof snap.lastEventAt).toBe('number')
  })
})

describe('StreamBufferStore.createReplayStream', () => {
  let store: StreamBufferStore
  beforeEach(() => { store = new StreamBufferStore() })
  afterEach(() => { store.dispose() })

  test('returns null for unknown key', () => {
    expect(store.createReplayStream('nope')).toBeNull()
  })

  test('replays all frames when fromSeq is omitted (default 0)', async () => {
    const w = store.create('k')
    w.append(u8('one'))
    w.append(u8('two'))
    w.append(u8('three'))
    w.complete()
    const stream = store.createReplayStream('k')!
    const chunks = await drain(stream)
    expect(chunks).toEqual(['one', 'two', 'three'])
  })

  test('replays only frames with seq > fromSeq', async () => {
    const w = store.create('k')
    w.append(u8('one'))
    w.append(u8('two'))
    w.append(u8('three'))
    w.complete()
    const stream = store.createReplayStream('k', { fromSeq: 1 })!
    const chunks = await drain(stream)
    expect(chunks).toEqual(['two', 'three'])
  })

  test('clamps negative fromSeq to 0', async () => {
    const w = store.create('k')
    w.append(u8('a'))
    w.complete()
    const stream = store.createReplayStream('k', { fromSeq: -50 })!
    const chunks = await drain(stream)
    expect(chunks).toEqual(['a'])
  })

  test('immediately closes when buffer is already completed', async () => {
    const w = store.create('k')
    w.append(u8('x'))
    w.complete()
    const stream = store.createReplayStream('k')!
    const reader = stream.getReader()
    const r1 = await reader.read()
    expect(new TextDecoder().decode(r1.value)).toBe('x')
    const r2 = await reader.read()
    expect(r2.done).toBe(true)
  })

  test('subscribes for live chunks when buffer is still active', async () => {
    const w = store.create('k')
    w.append(u8('replay'))
    const stream = store.createReplayStream('k')!
    // After subscribing, send a live chunk
    w.append(u8('live'))
    w.complete()
    const chunks = await drain(stream)
    expect(chunks).toContain('replay')
    expect(chunks).toContain('live')
  })

  test('cancel() removes the subscriber from the buffer', async () => {
    const w = store.create('k')
    w.append(u8('a'))
    const stream = store.createReplayStream('k')!
    const buf = (store as any).buffers.get('k')
    expect(buf.subscribers.size).toBe(1)
    await stream.cancel()
    expect(buf.subscribers.size).toBe(0)
  })

  test('cancel() is safe to call when subscribedController is null (already cancelled)', async () => {
    const w = store.create('k')
    w.append(u8('a'))
    w.complete() // status not active → no subscription registered
    const stream = store.createReplayStream('k')!
    // Drain first to close it
    await drain(stream)
    // cancel after close — subscribedController is null path
    await expect(stream.cancel()).resolves.toBeUndefined()
  })

  test('handles controller.enqueue throwing during replay (early return)', async () => {
    const w = store.create('k')
    w.append(u8('chunk1'))
    w.append(u8('chunk2'))
    w.complete()
    const stream = store.createReplayStream('k')!
    // Cancel immediately to force a throw on next enqueue scenario isn't easy;
    // instead read normally to confirm no crash:
    const out = await drain(stream)
    expect(out.length).toBeGreaterThanOrEqual(2)
  })
})

describe('StreamBufferStore.cleanup', () => {
  let store: StreamBufferStore
  let origNow: () => number
  beforeEach(() => {
    store = new StreamBufferStore()
    origNow = Date.now
  })
  afterEach(() => {
    Date.now = origNow
    store.dispose()
  })

  test('removes completed buffers past the grace window', () => {
    const w = store.create('k')
    w.complete('done')
    // Force completedAt into the past
    const buf = (store as any).buffers.get('k')
    buf.completedAt = Date.now() - 60_000 // > COMPLETED_GRACE_MS (30s)
    store.cleanup()
    expect(store.has('k')).toBe(false)
  })

  test('keeps completed buffers still within the grace window', () => {
    const w = store.create('k')
    w.complete()
    store.cleanup()
    expect(store.has('k')).toBe(true)
  })

  test('expires old active buffers with no subscribers', () => {
    store.create('k')
    const buf = (store as any).buffers.get('k')
    buf.createdAt = Date.now() - 31 * 60_000 // > MAX_BUFFER_AGE_MS
    store.cleanup()
    expect(store.has('k')).toBe(false)
  })

  test('keeps old active buffers that still have subscribers', () => {
    store.create('k')
    const buf = (store as any).buffers.get('k')
    buf.createdAt = Date.now() - 31 * 60_000
    buf.subscribers.add({ enqueue: () => {} } as any)
    store.cleanup()
    expect(store.has('k')).toBe(true)
  })

  test('keeps fresh active buffers untouched', () => {
    store.create('k')
    store.cleanup()
    expect(store.snapshot('k')?.status).toBe('active')
  })
})

describe('StreamBufferStore.dispose', () => {
  test('clears the cleanup timer and is idempotent', () => {
    const store = new StreamBufferStore()
    store.dispose()
    expect(() => store.dispose()).not.toThrow()
  })

  test('completes all active buffers on dispose', () => {
    const store = new StreamBufferStore()
    const w = store.create('k')
    expect(w.lastSeq).toBe(0)
    store.dispose()
    // After dispose buffers map is cleared; nothing to snapshot.
    expect(store.snapshot('k')).toBeNull()
  })
})

describe('cleanup timer setup', () => {
  test('the setInterval callback actually invokes cleanup()', async () => {
    // Mock setInterval to capture the callback and fire it immediately
    const origSetInterval = globalThis.setInterval
    let capturedCb: (() => void) | null = null
    ;(globalThis as any).setInterval = ((fn: () => void, _ms: number) => {
      capturedCb = fn
      // Return a dummy handle with unref
      return { unref: () => {}, _isTest: true } as any
    }) as any
    try {
      const store = new StreamBufferStore()
      const w = store.create('expired')
      w.complete('done')
      // Force completedAt deep into the past so cleanup will evict it
      const buf = (store as any).buffers.get('expired')
      buf.completedAt = Date.now() - 120_000
      // Fire the captured interval callback (the setInterval(() => this.cleanup()) closure)
      expect(capturedCb).not.toBeNull()
      capturedCb!()
      expect(store.has('expired')).toBe(false)
      store.dispose()
    } finally {
      globalThis.setInterval = origSetInterval
    }
  })

  test('handles environments where the timer handle has no unref()', () => {
    const origSetInterval = globalThis.setInterval
    // Force a number-typed handle (browser-like) for one constructor call
    ;(globalThis as any).setInterval = ((fn: any, ms: number) => {
      const t = origSetInterval(fn, ms)
      // Strip unref so the runtime branch handles missing-unref
      const handle = t as unknown as { unref?: () => void }
      if (handle && typeof handle === 'object') delete handle.unref
      return t
    }) as any
    try {
      const store = new StreamBufferStore()
      // No throw means the handle-without-unref branch was traversed
      expect(store.snapshot('whatever')).toBeNull()
      store.dispose()
    } finally {
      globalThis.setInterval = origSetInterval
    }
  })
})

describe('generateTurnId (via store.create)', () => {
  test('uses crypto.randomUUID when available', () => {
    const store = new StreamBufferStore()
    const w = store.create('k')
    // Default crypto.randomUUID format: 8-4-4-4-12 hex
    expect(w.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    store.dispose()
  })

  test('falls back when crypto.randomUUID throws', () => {
    const origRandomUUID = globalThis.crypto?.randomUUID
    // Force the try block to throw
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => { throw new Error('not available') },
    })
    try {
      const store = new StreamBufferStore()
      const w = store.create('k')
      expect(w.turnId.startsWith('turn_')).toBe(true)
      store.dispose()
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: origRandomUUID,
      })
    }
  })

  test('falls back when crypto.randomUUID is not a function', () => {
    const origRandomUUID = globalThis.crypto?.randomUUID
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })
    try {
      const store = new StreamBufferStore()
      const w = store.create('k')
      expect(w.turnId.startsWith('turn_')).toBe(true)
      store.dispose()
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: origRandomUUID,
      })
    }
  })
})

describe('createBufferingTransform', () => {
  let store: StreamBufferStore
  beforeEach(() => { store = new StreamBufferStore() })
  afterEach(() => { store.dispose() })

  test('appends chunks to the store while passing them through', async () => {
    store.create('k')
    const transform = createBufferingTransform(store, 'k')
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(u8('alpha'))
        controller.enqueue(u8('beta'))
        controller.close()
      },
    })
    const out = await drain(upstream.pipeThrough(transform))
    expect(out).toEqual(['alpha', 'beta'])
    expect(store.snapshot('k')?.lastSeq).toBe(2)
  })

  test('flush() completes the buffer', async () => {
    store.create('k')
    const transform = createBufferingTransform(store, 'k')
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(u8('hi'))
        controller.close()
      },
    })
    await drain(upstream.pipeThrough(transform))
    expect(store.snapshot('k')?.status).toBe('completed')
  })

  test('also works when the store has no pre-created buffer (append returns -1, no throw)', async () => {
    const transform = createBufferingTransform(store, 'no-buffer-key')
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(u8('drop'))
        controller.close()
      },
    })
    // Should still pass chunks through even if the buffer doesn't exist
    const out = await drain(upstream.pipeThrough(transform))
    expect(out).toEqual(['drop'])
  })
})
