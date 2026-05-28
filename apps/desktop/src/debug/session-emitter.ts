// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thin pub/sub for in-process debug session events.
 *
 * The Debug Console renderer doesn't talk to v8's inspector protocol
 * directly — it subscribes to this emitter, which is fed by whichever
 * source happens to be alive (the node-inspector-client when a real
 * `--inspect` session is running, or test fixtures, or the REPL itself
 * for its own echoed input).
 *
 * Keeping this layer pure-TS (no node-pty, no electron) makes it
 * unit-testable and means we can ship the UI before the full DAP /
 * Chrome DevTools Protocol wiring is finished — the emitter just stays
 * quiet until a producer is plugged in.
 *
 * Event types follow VS Code's Debug Console pill conventions:
 *   - 'stdout' / 'stderr'  → raw process I/O (from the terminal side)
 *   - 'console.log'        → v8 Runtime.consoleAPICalled (api='log')
 *   - 'console.error'      → v8 Runtime.consoleAPICalled (api='error')
 *   - 'console.warn'       → v8 Runtime.consoleAPICalled (api='warning')
 *   - 'expression'         → user typed at the REPL, echoed
 *   - 'result'             → REPL evaluation result
 *   - 'breakpoint'         → debugger hit a breakpoint
 *   - 'system'             → emitter chrome (session attached/detached)
 */

/** The pill rendered to the left of each line in the Debug Console. */
export type DebugEventKind =
  | 'stdout'
  | 'stderr'
  | 'console.log'
  | 'console.error'
  | 'console.warn'
  | 'expression'
  | 'result'
  | 'breakpoint'
  | 'system'

export interface DebugEvent {
  /** Stable monotonic id assigned by the emitter. Consumers use it for keys / dedupe. */
  id: number
  /** Pill type — see DebugEventKind. */
  kind: DebugEventKind
  /** Wall-clock at emission (ms since epoch). */
  ts: number
  /** Primary text payload. Always present; pre-formatted for `<pre>` rendering. */
  text: string
  /**
   * Optional structured payload — when v8 emits `Runtime.consoleAPICalled` with
   * argument objects, we carry the JSON-serialisable form here so the renderer
   * can show a collapsible tree.  Missing for plain stdout/stderr.
   */
  data?: unknown
  /** Optional source pill (e.g. 'script.js:42') shown after the kind pill. */
  source?: string
}

export type DebugListener = (ev: DebugEvent) => void

/**
 * In-process event bus.  Stateless w.r.t. transcript — the renderer keeps its
 * own buffer; the emitter is just a fan-out.  Listeners that throw are isolated
 * (one bad subscriber doesn't take down the others).
 */
export class DebugSessionEmitter {
  private listeners = new Set<DebugListener>()
  private nextId = 1
  /** True between `attached()` and `detached()` — the UI watches this for header chrome. */
  private _attached = false

  get isAttached(): boolean { return this._attached }

  /** Subscribe.  Returns an unsubscribe handle. */
  on(listener: DebugListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Emit a fully-formed event (id + ts filled in if absent). */
  emit(ev: Omit<DebugEvent, 'id' | 'ts'> & Partial<Pick<DebugEvent, 'id' | 'ts'>>): DebugEvent {
    const full: DebugEvent = {
      id: ev.id ?? this.nextId++,
      ts: ev.ts ?? Date.now(),
      kind: ev.kind,
      text: ev.text,
      data: ev.data,
      source: ev.source,
    }
    for (const l of [...this.listeners]) {
      try { l(full) } catch { /* swallow — listener bug shouldn't poison fan-out */ }
    }
    return full
  }

  /** Convenience helpers for the common event kinds. */
  stdout(text: string, source?: string): DebugEvent { return this.emit({ kind: 'stdout', text, source }) }
  stderr(text: string, source?: string): DebugEvent { return this.emit({ kind: 'stderr', text, source }) }
  consoleLog(text: string, data?: unknown, source?: string): DebugEvent {
    return this.emit({ kind: 'console.log', text, data, source })
  }
  expression(text: string): DebugEvent { return this.emit({ kind: 'expression', text }) }
  result(text: string, data?: unknown): DebugEvent { return this.emit({ kind: 'result', text, data }) }
  system(text: string): DebugEvent { return this.emit({ kind: 'system', text }) }

  /** Mark the session as attached and emit a chrome event. */
  markAttached(label: string): void {
    if (this._attached) return
    this._attached = true
    this.system(`Attached to ${label}`)
  }

  /** Mark detached + emit chrome event. */
  markDetached(reason?: string): void {
    if (!this._attached) return
    this._attached = false
    this.system(reason ? `Detached: ${reason}` : 'Detached')
  }

  /** Drop all listeners — used when the host disposes the panel. */
  dispose(): void {
    this.listeners.clear()
  }
}

/**
 * Process-wide singleton.  We deliberately keep a single global emitter so the
 * Debug Console panel doesn't have to thread refs through React context —
 * `getDebugSessionEmitter()` always returns the same instance for the life of
 * the renderer.
 */
let globalEmitter: DebugSessionEmitter | null = null

export function getDebugSessionEmitter(): DebugSessionEmitter {
  if (!globalEmitter) globalEmitter = new DebugSessionEmitter()
  return globalEmitter
}

/** Test-only: blow the singleton away so each test starts clean. */
export function __resetDebugSessionEmitterForTest(): void {
  if (globalEmitter) globalEmitter.dispose()
  globalEmitter = null
}
