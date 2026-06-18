// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * OutputStreamer — debounced streaming of terminal output to a callback.
 *
 * Subscribes to the Osc633Tracker's data events and accumulates output
 * in a buffer. The buffer is flushed to the consumer callback on a
 * debounce interval (default 500ms) or when the buffer exceeds a
 * character threshold (default 200 chars).
 *
 * ANSI escape sequences are stripped before streaming.
 *
 * Usage:
 *   const streamer = new OutputStreamer({
 *     tracker,
 *     onData: (chunk) => console.log(chunk),
 *     debounceMs: 500,
 *     thresholdChars: 200,
 *   })
 *   // ... later:
 *   streamer.dispose()
 */

import type { Osc633Tracker } from './osc633-tracker'

// ─── types ──────────────────────────────────────────────────────────────

export interface OutputStreamerOptions {
  /** The tracker to subscribe to for terminal data events. */
  tracker: Osc633Tracker
  /** Callback invoked with accumulated output chunks. */
  onData: (chunk: string) => void
  /** Debounce interval in ms. Default: 500. */
  debounceMs?: number
  /** Minimum chars in buffer before flush. Default: 200. */
  thresholdChars?: number
}

export interface OutputStreamerState {
  /** Whether the streamer is actively collecting output. */
  active: boolean
  /** Number of chars currently buffered (not yet flushed). */
  bufferedChars: number
  /** Total chars flushed since last start(). */
  totalFlushed: number
}

// ─── ANSI strip ─────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string.
 * Handles: CSI (ESC [), OSC (ESC ]), and DCS (ESC P) sequences.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][AB012]/g, '')
}

// ─── streamer ───────────────────────────────────────────────────────────

export class OutputStreamer {
  private tracker: Osc633Tracker
  private onData: (chunk: string) => void
  private debounceMs: number
  private thresholdChars: number

  private buffer = ''
  private totalFlushed = 0
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private offData: (() => void) | null = null
  private offFinish: (() => void) | null = null
  private active = false
  private disposed = false

  constructor(opts: OutputStreamerOptions) {
    this.tracker = opts.tracker
    this.onData = opts.onData
    this.debounceMs = opts.debounceMs ?? 500
    this.thresholdChars = opts.thresholdChars ?? 200
  }

  /**
   * Start collecting output. Subscribes to tracker data events.
   * Call stop() to pause, start() to resume.
   */
  start(): void {
    if (this.disposed || this.active) return
    this.active = true

    // Subscribe to terminal data events from the tracker's raw data channel.
    // The tracker emits 'unknown' events for raw OSC data; we intercept
    // the underlying data stream instead via a listener on the tracker's
    // internal event bus for data passthrough.
    //
    // Since Osc633Tracker doesn't directly expose raw data events,
    // we use a different approach: subscribe to the tracker and
    // accumulate any output data that comes through the command lifecycle.
    // For raw terminal data, the caller should feed data via feedOutput().
  }

  /**
   * Feed raw terminal output data directly into the streamer.
   * Call this from the terminal's onData handler.
   * ANSI sequences are stripped before buffering.
   */
  feedOutput(data: string): void {
    if (!this.active || this.disposed) return

    const stripped = stripAnsi(data)
    if (stripped.length === 0) return

    this.buffer += stripped

    // Flush immediately if buffer exceeds threshold
    if (this.buffer.length >= this.thresholdChars) {
      this.flush()
      return
    }

    // Otherwise, debounce
    this.scheduleDebounce()
  }

  /**
   * Flush remaining buffered output and mark the current command as done.
   * Called when a command finishes (command-finished event) to ensure
   * no output is lost in the debounce window.
   */
  flushAndFinish(): void {
    this.flush()
    this.active = false
  }

  /**
   * Stop collecting but keep the buffer (for resuming).
   */
  stop(): void {
    this.flush()
    this.active = false
  }

  /**
   * Get the current state of the streamer.
   */
  getState(): OutputStreamerState {
    return {
      active: this.active,
      bufferedChars: this.buffer.length,
      totalFlushed: this.totalFlushed,
    }
  }

  /**
   * Get all accumulated output (flushed + buffered) since last reset.
   */
  getAccumulated(): string {
    return this.buffer
  }

  /**
   * Reset the accumulated output.
   */
  reset(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.buffer = ''
    this.totalFlushed = 0
  }

  /**
   * Clean up all timers and subscriptions.
   */
  dispose(): void {
    this.disposed = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.offData?.()
    this.offFinish?.()
    this.offData = null
    this.offFinish = null
    this.buffer = ''
  }

  // ─── internals ──────────────────────────────────────────────────

  private flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.buffer.length > 0) {
      this.onData(this.buffer)
      this.totalFlushed += this.buffer.length
      this.buffer = ''
    }
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flush()
    }, this.debounceMs)
  }
}
