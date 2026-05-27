// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  MemorySink,
  TelemetryEmitter,
  consoleSink,
  type TelemetryEnvelope,
  type TelemetryEvent,
} from '../telemetry'

// ─── manual clock ──────────────────────────────────────────────

interface Clock {
  schedule(cb: () => void, ms: number): number
  cancel(h: number): void
  tickAll(): void
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
    tickAll() {
      const due = queue.splice(0)
      for (const { cb } of due) cb()
    },
    pending() { return queue.length },
  }
}

function makeEmitter(opts: { enabled?: boolean; flushAtCount?: number; flushIntervalMs?: number } = {}): {
  emitter: TelemetryEmitter
  sink: MemorySink
  clock: Clock
} {
  const sink = new MemorySink()
  const clock = makeClock()
  const emitter = new TelemetryEmitter({
    sink, enabled: opts.enabled, flushAtCount: opts.flushAtCount, flushIntervalMs: opts.flushIntervalMs,
    now: () => 1_700_000_000_000,
    schedule: clock.schedule, cancel: clock.cancel,
  })
  return { emitter, sink, clock }
}

// ─── opt-in posture ────────────────────────────────────────────

describe('TelemetryEmitter — opt-in posture', () => {
  it('defaults to disabled — emit() is a no-op', () => {
    const { emitter, sink } = makeEmitter()
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(sink.events).toHaveLength(0)
    expect(emitter.pendingCount()).toBe(0)
  })

  it('setEnabled(true) starts accepting events', () => {
    const { emitter, sink } = makeEmitter()
    emitter.setEnabled(true)
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(emitter.pendingCount()).toBe(1)
    emitter.flush()
    expect(sink.events).toHaveLength(1)
  })

  it('setEnabled(false) drops the queue and stops accepting', () => {
    const { emitter, sink } = makeEmitter({ enabled: true })
    emitter.emit({ kind: 'cmd-k.invoked' })
    emitter.setEnabled(false)
    expect(emitter.pendingCount()).toBe(0)
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(emitter.pendingCount()).toBe(0)
    expect(sink.events).toHaveLength(0)
  })

  it('setEnabled is idempotent on same value', () => {
    const { emitter } = makeEmitter()
    emitter.setEnabled(false)
    expect(emitter.isEnabled()).toBe(false)
    emitter.setEnabled(true)
    emitter.setEnabled(true)
    expect(emitter.isEnabled()).toBe(true)
  })
})

// ─── envelope shape ────────────────────────────────────────────

describe('TelemetryEmitter — envelope', () => {
  it('stamps ts + v + event on every envelope', () => {
    const { emitter, sink } = makeEmitter({ enabled: true })
    emitter.emit({ kind: 'cmd-k.invoked' })
    emitter.flush()
    const env: TelemetryEnvelope = sink.events[0]!
    expect(env.v).toBe(1)
    expect(env.ts).toBe(1_700_000_000_000)
    expect(env.event).toEqual({ kind: 'cmd-k.invoked' })
  })

  it('preserves typed payloads through the queue', () => {
    const { emitter, sink } = makeEmitter({ enabled: true })
    const ev: TelemetryEvent = { kind: 'command.failed', shell: '/bin/zsh', exitCode: 1 }
    emitter.emit(ev)
    emitter.flush()
    expect(sink.events[0]!.event).toEqual(ev)
  })
})

// ─── batching ──────────────────────────────────────────────────

describe('TelemetryEmitter — batching', () => {
  it('flushes when queue reaches flushAtCount', () => {
    const { emitter, sink } = makeEmitter({ enabled: true, flushAtCount: 3 })
    emitter.emit({ kind: 'cmd-k.invoked' })
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(sink.events).toHaveLength(0)
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(sink.events).toHaveLength(3)
    expect(emitter.pendingCount()).toBe(0)
  })

  it('flushes every flushIntervalMs even below count', () => {
    const { emitter, sink, clock } = makeEmitter({ enabled: true, flushIntervalMs: 1_000 })
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(sink.events).toHaveLength(0)
    // The interval should be armed.
    expect(clock.pending()).toBeGreaterThan(0)
    clock.tickAll()
    expect(sink.events).toHaveLength(1)
  })

  it('re-arms the interval after each flush', () => {
    const { emitter, clock } = makeEmitter({ enabled: true, flushIntervalMs: 1_000 })
    emitter.emit({ kind: 'cmd-k.invoked' })
    clock.tickAll()
    expect(clock.pending()).toBeGreaterThan(0)
    clock.tickAll()
    expect(clock.pending()).toBeGreaterThan(0)
  })

  it('manual flush() drains immediately without waiting for the timer', () => {
    const { emitter, sink, clock } = makeEmitter({ enabled: true, flushIntervalMs: 100_000 })
    emitter.emit({ kind: 'cmd-k.invoked' })
    emitter.flush()
    expect(sink.events).toHaveLength(1)
    expect(clock.pending()).toBeGreaterThan(0) // interval still armed
  })

  it('flush is a no-op when queue is empty', () => {
    const { emitter, sink } = makeEmitter({ enabled: true })
    emitter.flush()
    expect(sink.events).toHaveLength(0)
  })
})

// ─── dispose ──────────────────────────────────────────────────

describe('TelemetryEmitter — dispose', () => {
  it('flushes pending + cancels interval + silences subsequent emits', () => {
    const { emitter, sink, clock } = makeEmitter({ enabled: true, flushIntervalMs: 1_000 })
    emitter.emit({ kind: 'cmd-k.invoked' })
    emitter.dispose()
    expect(sink.events).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    emitter.emit({ kind: 'cmd-k.invoked' })
    expect(sink.events).toHaveLength(1)
  })

  it('dispose is idempotent', () => {
    const { emitter } = makeEmitter({ enabled: true })
    emitter.dispose()
    emitter.dispose()
  })
})

// ─── sink errors don't crash the emitter ──────────────────────

describe('TelemetryEmitter — sink failure tolerance', () => {
  it('survives a throwing sink', () => {
    const sink = { send() { throw new Error('boom') } }
    const emitter = new TelemetryEmitter({ sink, enabled: true })
    emitter.emit({ kind: 'cmd-k.invoked' })
    // No throw on flush
    expect(() => emitter.flush()).not.toThrow()
  })
})

// ─── consoleSink ──────────────────────────────────────────────

describe('consoleSink', () => {
  it('does not throw on send', () => {
    const sink = consoleSink()
    expect(() => sink.send([{ ts: 0, v: 1, event: { kind: 'cmd-k.invoked' } }])).not.toThrow()
  })
})

// ─── MemorySink ──────────────────────────────────────────────

describe('MemorySink', () => {
  it('records sent envelopes; clear() resets', () => {
    const sink = new MemorySink()
    sink.send([{ ts: 1, v: 1, event: { kind: 'cmd-k.invoked' } }])
    expect(sink.events).toHaveLength(1)
    sink.clear()
    expect(sink.events).toHaveLength(0)
  })
})
