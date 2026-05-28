// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tracker that folds a stream of OscEvents (from `@shogo/pty-core`'s
 * `OscDecoder`) into a list of `Command` records, each anchored to an
 * xterm.js IMarker for later UI navigation.
 *
 * State machine (per VS Code's shell-integration spec):
 *
 *     Idle ──A──▶ Prompting
 *                     │
 *                     │ B (prompt-end)
 *                     ▼
 *                 AwaitingCommand
 *                     │
 *                     │ C (pre-exec)   ← create Command, mark start
 *                     ▼
 *                  Running
 *                     │
 *                     │ D[;exit]       ← finalize Command, mark end
 *                     ▼
 *                 Finished ── A ──▶ Prompting (next loop iteration)
 *
 * The `P;Cwd=<path>` event updates `currentCwd` and stamps it onto the
 * NEXT command (so it reflects where the command runs, not where the
 * shell sat idle).
 *
 * Robustness:
 *   - Missing-B is tolerated: a C without a preceding B still opens
 *     a command, just without a captured prompt range.
 *   - Missing-D is tolerated on subsequent A: we close the previous
 *     command with exit=null so the UI can show "interrupted".
 *   - Out-of-band events (E, unknown, overflow) are forwarded to an
 *     optional listener for telemetry but don't drive the state machine.
 *
 * xterm.js dependency is kept narrow — we accept a `MarkerFactory` so
 * tests can substitute a counter without pulling in xterm.js.
 */

import type { OscEvent, Osc633Event, Osc133Event } from '@shogo/pty-core'

// ─── public types ───────────────────────────────────────────────────────

/** A minimal subset of xterm.js's IMarker — what we actually use. */
export interface CommandMarker {
  /** Monotonic line number this marker is anchored to. */
  readonly line: number
  /** Released when the marker is disposed (xterm.js compatible). */
  dispose?(): void
}

export interface MarkerFactory {
  /** Called when we want to anchor a position in the terminal buffer. */
  registerMarker(): CommandMarker | undefined
}

export interface Command {
  /** 1-based monotonic id, stable across renames. */
  id: number
  /** Best-effort command line. Empty until we receive an E event. */
  commandLine: string
  /** Working directory where the command ran, if known. */
  cwd: string | null
  /** Exit code from the D event. `null` if unknown / interrupted. */
  exitCode: number | null
  /** Marker for the prompt-start (A) row, if captured. */
  promptMarker: CommandMarker | null
  /** Marker for the command-start (C) row, if captured. */
  startMarker: CommandMarker | null
  /** Marker for the command-end (D) row, if captured. */
  endMarker: CommandMarker | null
  /** Wall-clock ms when the command started running, if known. */
  startedAt: number | null
  /** Wall-clock ms when the command finished, if known. */
  finishedAt: number | null
  /** Tracker state when this snapshot was taken. */
  state: CommandState
}

export type CommandState =
  | 'prompting' // A seen, awaiting B
  | 'awaiting' // B seen, awaiting C
  | 'running' // C seen, awaiting D
  | 'finished' // D seen, ready for next A

export type TrackerEvent =
  | { kind: 'command-started'; command: Command }
  | { kind: 'command-finished'; command: Command }
  | { kind: 'cwd-changed'; cwd: string }
  | { kind: 'unknown'; event: OscEvent }

export interface TrackerListener {
  (event: TrackerEvent): void
}

// ─── tracker ────────────────────────────────────────────────────────────

export class Osc633Tracker {
  private nextId = 1
  private current: Command | null = null
  private commands: Command[] = []
  private cwd: string | null = null
  private listeners = new Set<TrackerListener>()
  private markers: MarkerFactory

  constructor(markers: MarkerFactory = { registerMarker: () => undefined }) {
    this.markers = markers
  }

  /** Replace the marker factory after construction (e.g. when xterm mounts). */
  setMarkerFactory(markers: MarkerFactory): void {
    this.markers = markers
  }

  on(listener: TrackerListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Returns the in-progress command (if any) plus all finished ones. */
  snapshot(): { current: Command | null; commands: readonly Command[]; cwd: string | null } {
    return { current: this.current, commands: this.commands.slice(), cwd: this.cwd }
  }

  /** Test/debug accessor. */
  getCurrentCwd(): string | null { return this.cwd }

  /** Feed a single OSC event from the decoder. */
  feed(ev: OscEvent): void {
    if (ev.kind === 'osc-633') return this.handle633(ev)
    if (ev.kind === 'osc-133') return this.handle133(ev)
    // overflow / unknown-osc: surface to listeners but don't drive state.
    this.emit({ kind: 'unknown', event: ev })
  }

  /** Convenience for callers piping an array (e.g. one OscDecodeResult batch). */
  feedAll(events: readonly OscEvent[]): void {
    for (const e of events) this.feed(e)
  }

  // ─── 633 handler ────────────────────────────────────────────────────

  private handle633(ev: Osc633Event): void {
    switch (ev.letter) {
      case 'A':
        this.onPromptStart()
        break
      case 'B':
        this.onPromptEnd()
        break
      case 'C':
        this.onPreExec()
        break
      case 'D':
        this.onCommandDone(parseExit(ev.args[0]))
        break
      case 'E':
        if (this.current && (this.current.state === 'awaiting' || this.current.state === 'running')) {
          this.current.commandLine = ev.args.join(';')
        }
        break
      case 'P':
        this.onProperty(ev.args[0])
        break
      default:
        this.emit({ kind: 'unknown', event: ev })
    }
  }

  // ─── 133 handler ────────────────────────────────────────────────────

  private handle133(ev: Osc133Event): void {
    // OSC 133 is the 633 subset — A/B/C/D map 1:1.
    switch (ev.letter) {
      case 'A': this.onPromptStart(); break
      case 'B': this.onPromptEnd(); break
      case 'C': this.onPreExec(); break
      case 'D': this.onCommandDone(parseExit(ev.args[0])); break
      default:
        this.emit({ kind: 'unknown', event: ev })
    }
  }

  // ─── state transitions ───────────────────────────────────────────────

  private onPromptStart(): void {
    // If a previous command never received D, close it with null exit
    // and emit finished so listeners can render it as interrupted.
    if (this.current && (this.current.state === 'running' || this.current.state === 'awaiting')) {
      this.finishCurrent(null)
    }
    // Start a fresh command anchored at the A row.
    const cmd: Command = {
      id: this.nextId++,
      commandLine: '',
      cwd: this.cwd,
      exitCode: null,
      promptMarker: this.markers.registerMarker() ?? null,
      startMarker: null,
      endMarker: null,
      startedAt: null,
      finishedAt: null,
      state: 'prompting',
    }
    this.current = cmd
  }

  private onPromptEnd(): void {
    if (!this.current) {
      // B without preceding A — synthesise a minimal command record so
      // the next C still gets handled. Don't emit anything.
      this.current = {
        id: this.nextId++,
        commandLine: '',
        cwd: this.cwd,
        exitCode: null,
        promptMarker: null,
        startMarker: null,
        endMarker: null,
        startedAt: null,
        finishedAt: null,
        state: 'awaiting',
      }
      return
    }
    if (this.current.state === 'prompting') this.current.state = 'awaiting'
  }

  private onPreExec(): void {
    if (!this.current) {
      this.current = {
        id: this.nextId++,
        commandLine: '',
        cwd: this.cwd,
        exitCode: null,
        promptMarker: null,
        startMarker: null,
        endMarker: null,
        startedAt: null,
        finishedAt: null,
        state: 'awaiting',
      }
    }
    this.current.startMarker = this.markers.registerMarker() ?? null
    this.current.startedAt = Date.now()
    this.current.state = 'running'
    this.emit({ kind: 'command-started', command: this.current })
  }

  private onCommandDone(exit: number | null): void {
    if (!this.current) return
    this.finishCurrent(exit)
  }

  private finishCurrent(exit: number | null): void {
    if (!this.current) return
    this.current.exitCode = exit
    this.current.endMarker = this.markers.registerMarker() ?? null
    this.current.finishedAt = Date.now()
    this.current.state = 'finished'
    this.commands.push(this.current)
    this.emit({ kind: 'command-finished', command: this.current })
    this.current = null
  }

  private onProperty(token: string | undefined): void {
    if (!token) return
    // e.g. "Cwd=/tmp" — split once on '='.
    const eq = token.indexOf('=')
    if (eq <= 0) return
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (key === 'Cwd' || key === 'cwd') {
      this.cwd = value
      this.emit({ kind: 'cwd-changed', cwd: value })
    }
    // Future: IsWindows, ShellType, etc. — store opaquely on a side map
    // when we need them. Phase 6 will wire these for link resolution.
  }

  // ─── emit ────────────────────────────────────────────────────────────

  private emit(ev: TrackerEvent): void {
    for (const l of this.listeners) {
      try { l(ev) } catch { /* listener errors are not the tracker's problem */ }
    }
  }
}

function parseExit(s: string | undefined): number | null {
  if (s === undefined) return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}
