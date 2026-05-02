// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `OutputBatcher` coalesces the high-frequency stdout / stderr writes
 * that pour out of running shell commands into one flush per animation
 * frame. Verbose commands (`yes`, `find /`, `bun install`) emit thousands
 * of tiny chunks per second — re-rendering on every chunk pegs the main
 * thread.
 *
 * Why a class instead of inline state: the original implementation lived
 * inside `Terminal.tsx` as refs + closures, which is impossible to test
 * without rendering. A standalone class with a pluggable scheduler lets
 * tests drive flushes synchronously without resorting to fake timers
 * (which deadlock under happy-dom — see plan reference [happy-dom #1210]).
 */

export type Scheduler = (cb: () => void) => void

/**
 * Default scheduler — `requestAnimationFrame` in browsers, `queueMicrotask`
 * elsewhere. Tests pass a synchronous scheduler so flushes happen during
 * the same tick as the `append()` call.
 */
export function defaultScheduler(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(cb)
  } else {
    queueMicrotask(cb)
  }
}

export type BatcherCommit = (snapshot: Map<string, string>) => void

/**
 * Buffers per-session text and flushes the merged map to `commit` once
 * per scheduler tick. Calls to `append` between two flushes are
 * coalesced into a single `commit`.
 */
export class OutputBatcher {
  private pending = new Map<string, string>()
  private scheduled = false

  constructor(
    private commit: BatcherCommit,
    private schedule: Scheduler = defaultScheduler,
  ) {}

  append(sessionId: string, text: string): void {
    if (!text) return
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? '') + text)
    this.scheduleFlush()
  }

  /**
   * Drop any pending output for a session without flushing. Used when
   * the user runs `clear` so the buffered chunks don't bleed back in on
   * the next animation frame.
   */
  clear(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /**
   * Force-flush right now (synchronously). Used to land batched chunks
   * before appending a header / trailer line so ordering is stable.
   */
  flushNow(): void {
    this.scheduled = false
    if (this.pending.size === 0) return
    const snapshot = new Map(this.pending)
    this.pending.clear()
    this.commit(snapshot)
  }

  /** Drop all pending state for every session; used at unmount. */
  reset(): void {
    this.pending.clear()
    this.scheduled = false
  }

  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => this.flushNow())
  }
}
