// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Telemetry emitter (opt-in, behind `TerminalSettings.telemetryEnabled`).
 *
 * Three responsibilities:
 *
 *   1. **Typed event surface** — every event in the union has a
 *      compile-time shape. Adding a new event = one more case in the
 *      union. No string-based "name + props" anti-pattern.
 *
 *   2. **Sink abstraction** — hosts wire any backend (Posthog, a
 *      local logfile, the existing Shogo telemetry tube). The default
 *      `consoleSink()` is what dev mode uses.
 *
 *   3. **Batching + throttling** — events queue and flush in chunks
 *      every `flushIntervalMs` (default 10s) OR when the queue hits
 *      `flushAtCount` (default 25). The host's network round-trip
 *      doesn't bottleneck the renderer's hot path.
 *
 * Everything is opt-in: with `enabled: false` (default), every method
 * is a cheap no-op — `emit` doesn't even build the event object.
 */

// ─── event types ───────────────────────────────────────────────

export type TelemetryEvent =
  /** ⌘K popover opened (Phase 8). */
  | { kind: 'cmd-k.invoked' }
  /** ⌘K suggestion accepted with the LLM's draft. */
  | { kind: 'cmd-k.submitted'; promptLength: number; suggestionLength: number }
  /** ⌘K popover closed without submission. */
  | { kind: 'cmd-k.cancelled' }
  /** A command finished with non-zero exit (Phase 3 tracker). */
  | { kind: 'command.failed'; shell: string; exitCode: number | null }
  /** A command finished successfully. */
  | { kind: 'command.succeeded'; shell: string; durationMs: number | null }
  /** A QuickFix decoration was rendered (Phase 7). */
  | { kind: 'quick-fix.shown'; ruleId: string }
  /** The user clicked a QuickFix suggestion. */
  | { kind: 'quick-fix.invoked'; ruleId: string; actionKind: string }
  /** Shell-integration injector status at session spawn (Phase 3). */
  | { kind: 'shell-integration.detected'; shell: string; status: string }
  /** Session(s) restored on app boot (Phase 9). */
  | { kind: 'session.restored'; count: number; mode: string }
  /** Snapshot write failed (host-side disk issue). */
  | { kind: 'session.snapshot-failed' }
  /** Renderer transitioned the GPU state (Phase 5). */
  | { kind: 'renderer.state'; state: string }
  /** An OSC overflow happened during decoding (Phase 3 health signal). */
  | { kind: 'osc.overflow'; droppedBytes: number }

export interface TelemetryEnvelope {
  /** Wall-clock ms when the event was queued. */
  ts: number
  /** Schema version of the envelope itself. */
  v: 1
  event: TelemetryEvent
}

// ─── sinks ─────────────────────────────────────────────────────

export interface TelemetrySink {
  /** Receives a batch of envelopes. Implementation owns retry/backoff. */
  send(events: readonly TelemetryEnvelope[]): void | Promise<void>
}

/** Stdout / console.debug sink for development. Never throws. */
export function consoleSink(): TelemetrySink {
  return {
    send(events) {
      for (const e of events) {
        try { console.debug('[shogo-terminal]', e.event.kind, e) } catch { /* */ }
      }
    },
  }
}

/** In-memory sink for tests; exposes the buffer for assertions. */
export class MemorySink implements TelemetrySink {
  readonly events: TelemetryEnvelope[] = []
  send(envelopes: readonly TelemetryEnvelope[]): void {
    for (const e of envelopes) this.events.push(e)
  }
  clear(): void { this.events.length = 0 }
}

// ─── emitter ───────────────────────────────────────────────────

export interface TelemetryEmitterOptions {
  sink: TelemetrySink
  /** Master switch; defaults to false (opt-in). */
  enabled?: boolean
  /** Flush after this many queued events. Default 25. */
  flushAtCount?: number
  /** Flush every N ms even if queue is below the count. Default 10_000. */
  flushIntervalMs?: number
  /** Clock for tests. */
  now?: () => number
  /** Scheduler for the periodic flush. */
  schedule?(cb: () => void, ms: number): number
  cancel?(handle: number): void
}

export class TelemetryEmitter {
  private readonly sink: TelemetrySink
  private enabled: boolean
  private readonly flushAtCount: number
  private readonly flushIntervalMs: number
  private readonly now: () => number
  private readonly schedule: (cb: () => void, ms: number) => number
  private readonly cancelSched: (h: number) => void

  private queue: TelemetryEnvelope[] = []
  private intervalHandle: number | null = null
  private disposed = false

  constructor(opts: TelemetryEmitterOptions) {
    this.sink = opts.sink
    this.enabled = opts.enabled ?? false
    this.flushAtCount = Math.max(1, opts.flushAtCount ?? 25)
    this.flushIntervalMs = Math.max(100, opts.flushIntervalMs ?? 10_000)
    this.now = opts.now ?? Date.now
    if (opts.schedule && opts.cancel) {
      this.schedule = opts.schedule
      this.cancelSched = opts.cancel
    } else {
      this.schedule = (cb, ms) => setTimeout(cb, ms) as unknown as number
      this.cancelSched = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
    }
    this.armInterval()
  }

  // ─── controls ─────────────────────────────────────────────

  setEnabled(value: boolean): void {
    if (this.enabled === value) return
    this.enabled = value
    if (value) this.armInterval()
    else {
      this.disarmInterval()
      this.queue.length = 0
    }
  }

  isEnabled(): boolean { return this.enabled }

  /** Queue an event. No-op when disabled. */
  emit(event: TelemetryEvent): void {
    if (!this.enabled || this.disposed) return
    this.queue.push({ ts: this.now(), v: 1, event })
    if (this.queue.length >= this.flushAtCount) this.flush()
  }

  /** Drain the queue synchronously into the sink. */
  flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0)
    try { void this.sink.send(batch) } catch { /* */ }
  }

  /** Number of events currently waiting to flush. */
  pendingCount(): number { return this.queue.length }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disarmInterval()
    this.flush()
  }

  // ─── interval timer ──────────────────────────────────────

  private armInterval(): void {
    if (this.intervalHandle !== null || this.disposed) return
    const tick = (): void => {
      this.intervalHandle = null
      if (this.disposed) return
      this.flush()
      if (this.enabled) this.armInterval()
    }
    this.intervalHandle = this.schedule(tick, this.flushIntervalMs)
  }

  private disarmInterval(): void {
    if (this.intervalHandle === null) return
    this.cancelSched(this.intervalHandle)
    this.intervalHandle = null
  }
}

// ─── tiny convenience for the common pattern ──────────────────

/**
 * Build a default emitter wired to `consoleSink()`. Useful for dev /
 * smoke tests. apps/desktop wires a real network sink.
 */
export function devTelemetry(opts: Partial<TelemetryEmitterOptions> = {}): TelemetryEmitter {
  return new TelemetryEmitter({ sink: consoleSink(), ...opts })
}
