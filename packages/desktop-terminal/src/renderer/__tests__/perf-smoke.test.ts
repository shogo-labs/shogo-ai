// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 14 perf smoke gate.
 *
 * Goal: prove the renderer's *algorithmic* throughput hasn't regressed.
 * We can't run a real FPS gate in bun:test (no DOM, no GPU, no real
 * rAF cadence), so we substitute a deterministic frame clock and
 * verify three properties that, together, would translate to a 60fps
 * UI on real hardware:
 *
 *   1. **Bounded per-frame work.**
 *      A 1 MB burst flushes through `WriteBatcher` in N frames where
 *      `N ≤ ceil(bytes / maxBytesPerFrame) + 1`. The "+1" accounts
 *      for the trailing frame that schedules itself idle.
 *
 *   2. **Coalesced sink calls.**
 *      For a homogeneous (all-string) input stream, the batcher emits
 *      exactly one sink call per frame — no per-chunk fan-out, no
 *      per-byte fan-out. This is what keeps xterm.js's render
 *      pipeline from thrashing.
 *
 *   3. **Scrollback append is amortised O(1).**
 *      10 000 appends to `ScrollbackRing` complete in under a generous
 *      wall-clock budget (250 ms in CI). This catches accidental
 *      O(n²) regressions from naive concat-everywhere refactors.
 *      The number is intentionally loose to avoid flake — we're
 *      hunting for orders-of-magnitude regressions, not microseconds.
 *
 * Real on-device FPS measurement (Playwright + `PerformanceObserver`)
 * is deferred to the e2e harness in Phase 14b.
 */

import { describe, expect, it } from 'bun:test'
import { WriteBatcher } from '../write-batcher'
import { ScrollbackRing } from '../../../../pty-core/src/scrollback-ring'

/** Deterministic frame clock — caller advances frames by calling `tick()`. */
function makeFrameClock(): {
  schedule: (cb: FrameRequestCallback) => number
  cancel: (handle: number) => void
  tick(): void
  pendingFrames(): number
} {
  let nextHandle = 1
  let pending: Array<{ handle: number; cb: FrameRequestCallback }> = []
  let t = 0
  return {
    schedule(cb) {
      const handle = nextHandle++
      pending.push({ handle, cb })
      return handle
    },
    cancel(handle) {
      pending = pending.filter((p) => p.handle !== handle)
    },
    tick() {
      const due = pending
      pending = []
      t += 16
      for (const p of due) p.cb(t)
    },
    pendingFrames() { return pending.length },
  }
}

describe('Phase 14 — perf smoke', () => {
  it('1 MB burst drains in bounded frames with bounded sink calls', () => {
    const clock = makeFrameClock()
    const sinkCalls: number[] = []
    const batcher = new WriteBatcher({
      sink: (chunk) => { sinkCalls.push(typeof chunk === 'string' ? chunk.length : chunk.byteLength) },
      maxBytesPerFrame: 256 * 1024,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    // Inject 1 MB in 1024-byte chunks (typical PTY chunk-size).
    const chunk = 'x'.repeat(1024)
    const totalBytes = 1024 * 1024
    const chunks = totalBytes / 1024
    for (let i = 0; i < chunks; i++) batcher.write(chunk)

    expect(batcher.pendingBytes).toBe(totalBytes)

    // Drive frames until queue drains.
    let frames = 0
    while (batcher.pendingBytes > 0) {
      if (frames > 64) throw new Error('drain stuck — would never reach 60fps')
      clock.tick()
      frames++
    }
    // One trailing tick for the self-cancelling re-schedule.
    if (clock.pendingFrames() > 0) clock.tick()

    // Property 1: bounded frames. 1 MiB / 256 KiB = 4 budgeted flushes.
    // The batcher splits the over-budget chunk into the next frame, so
    // we allow one extra frame for the head-split edge case.
    const expectedMaxFrames = Math.ceil(totalBytes / (256 * 1024)) + 1
    expect(frames).toBeLessThanOrEqual(expectedMaxFrames)

    // Property 2: coalesced sink calls. Homogeneous string input means
    // each frame's run concatenates to a single string → one sink call.
    expect(sinkCalls.length).toBeLessThanOrEqual(expectedMaxFrames)
    // Total bytes delivered equals total bytes queued.
    expect(sinkCalls.reduce((a, b) => a + b, 0)).toBe(totalBytes)
  })

  it('homogeneous binary input coalesces to one sink call per frame', () => {
    // Same invariant as the string case but with Uint8Array — proves the
    // coalesce path works for the binary fast lane that the PTY runtime
    // actually feeds in.
    const clock = makeFrameClock()
    let sinkCalls = 0
    let bytesDelivered = 0
    const batcher = new WriteBatcher({
      sink: (chunk) => {
        sinkCalls++
        bytesDelivered += typeof chunk === 'string' ? chunk.length : chunk.byteLength
      },
      maxBytesPerFrame: 256 * 1024,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    const chunk = new Uint8Array(1024).fill(0x42)
    for (let i = 0; i < 1024; i++) batcher.write(chunk)   // 1 MiB
    while (batcher.pendingBytes > 0) clock.tick()
    if (clock.pendingFrames() > 0) clock.tick()

    expect(sinkCalls).toBeLessThanOrEqual(5)
    expect(bytesDelivered).toBe(1024 * 1024)
  })

  it('ScrollbackRing.append is amortised O(1)', () => {
    const ring = new ScrollbackRing(8 * 1024 * 1024) // 8 MiB cap
    const chunk = new Uint8Array(1024).fill(0x41)

    const start = performance.now()
    for (let i = 1; i <= 10_000; i++) ring.append(i, chunk)
    const elapsed = performance.now() - start

    // 10k 1KiB appends through ScrollbackRing should complete well under
    // a quarter second even on a slow CI runner. If this fires, look for
    // an accidental quadratic copy somewhere in append().
    expect(elapsed).toBeLessThan(250)
    // Eviction kept us within the cap.
    expect(ring.size).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('ScrollbackRing.replaySince stays linear in retained chunks', () => {
    const ring = new ScrollbackRing(8 * 1024 * 1024)
    const chunk = new Uint8Array(1024).fill(0x42)
    for (let i = 1; i <= 8000; i++) ring.append(i, chunk)

    const start = performance.now()
    // 100 replays from the head — would be O(n²) if replay walked every chunk
    // every time without binary-searching the start.
    for (let i = 0; i < 100; i++) {
      const r = ring.replaySince(0)
      expect(r.bytes.byteLength).toBeGreaterThan(0)
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  it('WriteBatcher.flushNow synchronously drains regardless of queue size', () => {
    const clock = makeFrameClock()
    let delivered = 0
    const batcher = new WriteBatcher({
      sink: (c) => { delivered += typeof c === 'string' ? c.length : c.byteLength },
      maxBytesPerFrame: 64 * 1024,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    for (let i = 0; i < 2048; i++) batcher.write('x'.repeat(1024))   // 2 MiB
    expect(batcher.pendingBytes).toBe(2 * 1024 * 1024)
    batcher.flushNow()
    expect(batcher.pendingBytes).toBe(0)
    expect(delivered).toBe(2 * 1024 * 1024)
    // The pending frame was cancelled, so no further sink calls happen on tick.
    const before = delivered
    clock.tick()
    expect(delivered).toBe(before)
  })
})
