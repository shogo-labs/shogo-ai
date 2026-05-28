// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { WriteBatcher, coalesceChunks, type WriteChunk } from '../write-batcher'

interface ManualClock {
  schedule: (cb: FrameRequestCallback) => number
  cancel: (h: number) => void
  /** Run all scheduled frames once. */
  tick(): void
  pending(): number
}

function makeClock(): ManualClock {
  const queue: { id: number; cb: FrameRequestCallback }[] = []
  let nextId = 1
  return {
    schedule(cb): number {
      const id = nextId++
      queue.push({ id, cb })
      return id
    },
    cancel(h): void {
      const idx = queue.findIndex((e) => e.id === h)
      if (idx >= 0) queue.splice(idx, 1)
    },
    tick(): void {
      const due = queue.splice(0)
      for (const { cb } of due) cb(performance.now())
    },
    pending(): number { return queue.length },
  }
}

function makeSink(): { calls: WriteChunk[]; fn: (c: WriteChunk) => void } {
  const calls: WriteChunk[] = []
  return { calls, fn: (c) => calls.push(c) }
}

// ─── coalesceChunks (pure) ──────────────────────────────────────────────

describe('coalesceChunks', () => {
  it('returns single-element arrays unchanged', () => {
    expect(coalesceChunks(['abc'])).toEqual(['abc'])
  })
  it('concatenates adjacent strings', () => {
    expect(coalesceChunks(['a', 'b', 'c'])).toEqual(['abc'])
  })
  it('concatenates adjacent Uint8Arrays', () => {
    const out = coalesceChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
    expect(out).toHaveLength(1)
    expect(Array.from(out[0] as Uint8Array)).toEqual([1, 2, 3, 4])
  })
  it('splits at type boundaries', () => {
    const out = coalesceChunks(['a', new Uint8Array([1]), 'b'])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('a')
    expect(out[2]).toBe('b')
  })
  it('coalesces runs on either side of a boundary', () => {
    const out = coalesceChunks(['a', 'b', new Uint8Array([1]), new Uint8Array([2]), 'c'])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('ab')
    expect(Array.from(out[1] as Uint8Array)).toEqual([1, 2])
    expect(out[2]).toBe('c')
  })
})

// ─── basic batching ────────────────────────────────────────────────────

describe('WriteBatcher — basic batching', () => {
  it('does not flush until the frame fires', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.write('a'); b.write('b'); b.write('c')
    expect(sink.calls).toHaveLength(0)
    expect(clock.pending()).toBe(1)
    clock.tick()
    expect(sink.calls).toEqual(['abc'])
  })

  it('schedules exactly one frame for a burst', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    for (let i = 0; i < 100; i++) b.write(`x${i}`)
    expect(b.frameCount).toBe(1)
    clock.tick()
    expect(sink.calls).toHaveLength(1)
  })

  it('preserves byte order across mixed string + Uint8Array', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.write('A')
    b.write(new Uint8Array([0x42])) // 'B'
    b.write('C')
    clock.tick()
    expect(sink.calls).toHaveLength(3)
    expect(sink.calls[0]).toBe('A')
    expect(Array.from(sink.calls[1] as Uint8Array)).toEqual([0x42])
    expect(sink.calls[2]).toBe('C')
  })

  it('ignores empty chunks', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.write(''); b.write(new Uint8Array(0))
    expect(clock.pending()).toBe(0)
    clock.tick()
    expect(sink.calls).toHaveLength(0)
  })
})

// ─── per-frame budget ─────────────────────────────────────────────────

describe('WriteBatcher — per-frame byte budget', () => {
  it('splits a single oversized chunk across frames', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({
      sink: sink.fn,
      schedule: clock.schedule,
      cancel: clock.cancel,
      maxBytesPerFrame: 4096, // floored to 1024 actually — set high enough
    })
    const huge = 'x'.repeat(10_000)
    b.write(huge)
    clock.tick()
    // first frame delivered up to ~4096 bytes; rest re-scheduled
    expect(sink.calls).toHaveLength(1)
    expect((sink.calls[0] as string).length).toBe(4096)
    expect(b.pendingBytes).toBe(10_000 - 4096)
    clock.tick()
    expect(sink.calls).toHaveLength(2)
    clock.tick()
    expect(sink.calls).toHaveLength(3)
    expect(b.pendingBytes).toBe(0)
    // Concatenated total reproduces original
    const total = (sink.calls as string[]).join('')
    expect(total).toBe(huge)
  })

  it('keeps small chunks whole when budget allows', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({
      sink: sink.fn,
      schedule: clock.schedule,
      cancel: clock.cancel,
      maxBytesPerFrame: 4096,
    })
    for (let i = 0; i < 50; i++) b.write('x'.repeat(50)) // 2500 bytes total
    clock.tick()
    expect(sink.calls).toHaveLength(1)
    expect((sink.calls[0] as string).length).toBe(2500)
  })

  it('floors per-frame budget to 1024 minimum', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({
      sink: sink.fn,
      schedule: clock.schedule,
      cancel: clock.cancel,
      maxBytesPerFrame: 1, // intent: tiny — actual floor is 1024
    })
    b.write('x'.repeat(2000))
    clock.tick()
    expect((sink.calls[0] as string).length).toBe(1024)
  })
})

// ─── flushNow / dispose ──────────────────────────────────────────────

describe('WriteBatcher — flushNow + dispose', () => {
  it('flushNow drains the queue synchronously and cancels the pending frame', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.write('a'); b.write('b')
    expect(clock.pending()).toBe(1)
    b.flushNow()
    expect(clock.pending()).toBe(0)
    expect(sink.calls).toEqual(['ab'])
  })

  it('dispose drops the queue and silences subsequent writes', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.write('a')
    b.dispose()
    expect(clock.pending()).toBe(0)
    b.write('b')
    clock.tick()
    expect(sink.calls).toHaveLength(0)
  })

  it('dispose is idempotent', () => {
    const clock = makeClock()
    const sink = makeSink()
    const b = new WriteBatcher({ sink: sink.fn, schedule: clock.schedule, cancel: clock.cancel })
    b.dispose(); b.dispose()
  })
})
