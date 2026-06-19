// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentTerminalBridge — high-level API for the agent to create terminals,
 * send commands, and await their completion.
 *
 * This is the "agent creates terminals" + "agent waits for completion"
 * layer that closes the Cursor parity gap. It wraps the existing
 * Osc633Tracker + SurfacePtyClient primitives into a Promise-based
 * interface that the agent loop can call.
 *
 * Usage (from the agent loop / LLM tool-call handler):
 *
 *   const bridge = new AgentTerminalBridge({ tracker, client })
 *   const result = await bridge.sendCommand('npm test')
 *   if (result.exitCode !== 0) {
 *     // Agent reads result.output and decides what to fix
 *   }
 *
 * For background commands:
 *
 *   const task = bridge.sendCommandBackground('npm run build')
 *   // ... agent continues reasoning ...
 *   const status = bridge.getTaskStatus(task.id)
 */

import type { Osc633Tracker, Command } from './osc633-tracker'
import { stripAnsi } from './strip-ansi'

// ─── types ──────────────────────────────────────────────────────────────

export interface AgentTerminalBridgeOptions {
  /** The tracker for the terminal the agent operates in. */
  tracker: Osc633Tracker
  /** The raw write function (from SurfacePtyClient.send or DesktopPtyClient). */
  send: (data: string) => void
  /** Signal function to send POSIX signals to the PTY. Optional. */
  signal?: (sig: 'INT' | 'TERM') => void
  /** Max ms to wait for a command to complete before timing out. Default: 120s. */
  commandTimeoutMs?: number
}

export interface CommandResult {
  /** The command that was executed. */
  command: string
  /** Exit code (null if interrupted / timed out). */
  exitCode: number | null
  /** Working directory where the command ran. */
  cwd: string | null
  /** Wall-clock duration in ms. */
  durationMs: number | null
  /** Whether the command timed out. */
  timedOut: boolean
  /** Accumulated output while the command was running (ANSI-stripped). */
  output?: string
}

export interface SendCommandOptions {
  /** Called with streaming output chunks as the command runs. */
  onOutput?: (chunk: string) => void
  /** Max ms to wait. Overrides the bridge default. */
  timeoutMs?: number
}

export interface BackgroundTask {
  id: string
  command: string
  /** Resolves when the command finishes (or null if already resolved). */
  promise: Promise<CommandResult>
  /** Cancel the timeout watcher. */
  dispose(): void
}

/**
 * One in-flight command. A waiter is created on sendCommand and lives in the
 * `startWaiters` FIFO until the tracker emits `command-started`, at which point
 * it is bound to a tracker command id and moved into `pendingByCmd`. The same
 * waiter (and its timer) covers both the waiting-for-start and running phases,
 * so there is exactly one timer and one resolve path per command.
 */
interface Waiter {
  command: string
  timeoutMs: number
  onOutput?: (chunk: string) => void
  /** Accumulated, ANSI-stripped output for THIS command only. */
  output: string
  resolved: boolean
  /** Tracker command id once `command-started` has bound this waiter. */
  cmdId: number | null
  /** Single timer covering start-wait + run. */
  timer: ReturnType<typeof setTimeout> | null
  /** Grace timer used by interruptCommand when the shell exits silently. */
  graceTimer?: ReturnType<typeof setTimeout>
  /** Resolves the caller's promise. */
  resolveFn: (result: CommandResult) => void
}

// ─── bridge ─────────────────────────────────────────────────────────────

export class AgentTerminalBridge {
  private tracker: Osc633Tracker
  /** Wrapped send — always calls the latest client.send via a ref indirection. */
  private _sendRef: { fn: (data: string) => void; signal?: (sig: 'INT' | 'TERM') => void }
  private commandTimeoutMs: number
  private taskCounter = 0

  /**
   * Commands that have been sent but not yet matched to a `command-started`
   * event, in send order. Terminals execute sequentially, so FIFO matching
   * correctly correlates each waiter with the next started command.
   */
  private startWaiters: Waiter[] = []

  /** Commands bound to a tracker command id and awaiting completion. */
  private pendingByCmd = new Map<number, Waiter>()

  /** Background tasks by ID. */
  private tasks = new Map<string, BackgroundTask>()

  /** The command id of the command currently producing output (most recent start). */
  private activeCommandId: number | null = null

  /**
   * Captured output of recently finished commands, keyed by tracker command id,
   * so consumers (context aggregator / enrichMessage) can attach real output to
   * the tracker's marker-only Command snapshots. Capped to avoid unbounded
   * growth in long sessions.
   */
  private outputHistory = new Map<number, string>()
  private static readonly OUTPUT_HISTORY_LIMIT = 20

  private off: (() => void) | null = null
  private disposed = false

  constructor(opts: AgentTerminalBridgeOptions) {
    this.tracker = opts.tracker
    this._sendRef = { fn: opts.send, signal: opts.signal }
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 120_000

    // ONE permanent listener for the whole bridge lifetime — no per-command
    // listeners, so there is nothing to leak on timeout/dispose.
    this.off = this.tracker.on((ev) => {
      if (ev.kind === 'command-started') this.onCommandStarted(ev.command)
      else if (ev.kind === 'command-finished') this.onCommandFinished(ev.command)
    })
  }

  /**
   * Feed raw terminal output data into the ACTIVE command's output accumulator.
   * Call this from the terminal's onData handler while a command is running.
   * ANSI sequences are stripped automatically. Output is attributed to the
   * single active command, never fanned out to all pending commands.
   */
  feedOutput(data: string): void {
    const stripped = stripAnsi(data)
    if (!stripped) return
    const cmdId = this.activeCommandId
    if (cmdId == null) return
    const waiter = this.pendingByCmd.get(cmdId)
    if (!waiter) return
    waiter.output += stripped
    waiter.onOutput?.(stripped)
  }

  /**
   * Update the send function (e.g. when the terminal reconnects).
   */
  setSend(fn: (data: string) => void): void {
    this._sendRef.fn = fn
  }

  /**
   * Send a command to the terminal and wait for it to complete.
   * Returns a CommandResult with exit code, duration, output, etc.
   *
   * Resolves with `timedOut: true` if the command doesn't finish
   * within `timeoutMs` (default 120s) — including the case where
   * `command-started` never arrives (no shell integration).
   */
  sendCommand(command: string, options?: SendCommandOptions): Promise<CommandResult> {
    if (this.disposed) {
      return Promise.resolve({ command, exitCode: null, cwd: null, durationMs: null, timedOut: false })
    }

    const timeoutMs = options?.timeoutMs ?? this.commandTimeoutMs
    return new Promise<CommandResult>((resolve) => {
      const waiter = this.enqueueWaiter(command, timeoutMs, options?.onOutput, resolve)
      // Fire the command AFTER the waiter is queued so a synchronous tracker
      // emit (there shouldn't be one, but be safe) finds its waiter.
      this._sendRef.fn(`${command}\r`)
      void waiter
    })
  }

  /**
   * Send a command without waiting for completion.
   * Returns a BackgroundTask that can be polled or awaited later.
   */
  sendCommandBackground(command: string): BackgroundTask {
    const id = `bg_${++this.taskCounter}`
    let resolveFn!: (result: CommandResult) => void
    const promise = new Promise<CommandResult>((resolve) => { resolveFn = resolve })

    const waiter = this.enqueueWaiter(command, this.commandTimeoutMs, undefined, (result) => {
      resolveFn(result)
      this.tasks.delete(id)
    })
    this._sendRef.fn(`${command}\r`)

    const task: BackgroundTask = {
      id,
      command,
      promise,
      dispose: () => {
        this.finish(waiter, { command, exitCode: null, cwd: null, durationMs: null, timedOut: false })
        this.tasks.delete(id)
      },
    }
    this.tasks.set(id, task)
    return task
  }

  /**
   * Get the status of a background task.
   * Returns null if the task ID is unknown.
   */
  getTaskStatus(id: string): BackgroundTask | null {
    return this.tasks.get(id) ?? null
  }

  /**
   * Interrupt the currently running command by sending SIGINT.
   * If no command is running, returns null immediately.
   * The pending promise resolves with `exitCode: null` and `timedOut: false`
   * either via `command-finished` or, if the shell exits silently, a 2s grace.
   */
  interruptCommand(): CommandResult | null {
    const cmdId = this.activeCommandId
    if (cmdId == null) return null

    this.sendSignal('INT')
    const waiter = this.pendingByCmd.get(cmdId)
    if (waiter && !waiter.graceTimer) {
      waiter.graceTimer = setTimeout(() => {
        this.finish(waiter, {
          command: waiter.command,
          exitCode: null,
          cwd: null,
          durationMs: null,
          timedOut: false,
        })
      }, 2000)
    }
    return null
  }

  /**
   * Send a POSIX signal to the terminal's PTY process.
   * The terminal surface must call `client.signal(sig)` under the hood.
   */
  sendSignal(sig: 'INT' | 'TERM'): void {
    this._sendRef.signal?.(sig)
  }

  /**
   * Get recent commands from the tracker snapshot.
   * Useful for the agent to review what was run.
   */
  getRecentCommands(limit: number = 5): Command[] {
    return this.tracker.snapshot().commands.slice(-limit)
  }

  /**
   * Get the current CWD from the tracker.
   */
  getCurrentCwd(): string | null {
    return this.tracker.snapshot().cwd
  }

  /**
   * Clean up listeners and resolve pending promises as cancelled.
   */
  dispose(): void {
    this.disposed = true
    this.off?.()
    this.off = null
    const all = [...this.startWaiters, ...this.pendingByCmd.values()]
    for (const waiter of all) {
      this.finish(waiter, { command: waiter.command, exitCode: null, cwd: null, durationMs: null, timedOut: false })
    }
    this.startWaiters = []
    this.pendingByCmd.clear()
    this.activeCommandId = null
    this.tasks.clear()
    this.outputHistory.clear()
  }

  // ─── internals ──────────────────────────────────────────────────

  /** Create a waiter, start its single timeout, and queue it for start-matching. */
  private enqueueWaiter(
    command: string,
    timeoutMs: number,
    onOutput: ((chunk: string) => void) | undefined,
    resolveFn: (result: CommandResult) => void,
  ): Waiter {
    const waiter: Waiter = {
      command,
      timeoutMs,
      onOutput,
      output: '',
      resolved: false,
      cmdId: null,
      timer: null,
      resolveFn,
    }
    waiter.timer = setTimeout(() => {
      this.finish(waiter, { command, exitCode: null, cwd: null, durationMs: timeoutMs, timedOut: true })
    }, timeoutMs)
    this.startWaiters.push(waiter)
    return waiter
  }

  /** Resolve a waiter exactly once and remove it from every collection. */
  private finish(waiter: Waiter, result: CommandResult): void {
    if (waiter.resolved) return
    waiter.resolved = true
    if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null }
    if (waiter.graceTimer) { clearTimeout(waiter.graceTimer); waiter.graceTimer = undefined }
    const qi = this.startWaiters.indexOf(waiter)
    if (qi >= 0) this.startWaiters.splice(qi, 1)
    if (waiter.cmdId != null) {
      this.pendingByCmd.delete(waiter.cmdId)
      if (this.activeCommandId === waiter.cmdId) this.activeCommandId = null
      if (waiter.output) this.recordOutput(waiter.cmdId, waiter.output)
    }
    waiter.resolveFn({ ...result, output: waiter.output || undefined })
  }

  /** Persist a finished command's output, evicting the oldest beyond the cap. */
  private recordOutput(cmdId: number, output: string): void {
    this.outputHistory.set(cmdId, output)
    while (this.outputHistory.size > AgentTerminalBridge.OUTPUT_HISTORY_LIMIT) {
      const oldest = this.outputHistory.keys().next().value
      if (oldest === undefined) break
      this.outputHistory.delete(oldest)
    }
  }

  /** Captured output for a finished command id, if still retained. */
  getCommandOutput(cmdId: number): string | undefined {
    return this.outputHistory.get(cmdId)
  }

  private onCommandStarted(cmd: Command): void {
    // FIFO: the oldest unmatched waiter owns this started command. If the queue
    // is empty the command was typed by the user, not the agent — ignore it.
    const waiter = this.startWaiters.shift()
    if (!waiter) return
    waiter.cmdId = cmd.id
    this.activeCommandId = cmd.id
    this.pendingByCmd.set(cmd.id, waiter)
  }

  private onCommandFinished(cmd: Command): void {
    const waiter = this.pendingByCmd.get(cmd.id)
    if (!waiter) return
    const durationMs = (cmd.startedAt != null && cmd.finishedAt != null)
      ? cmd.finishedAt - cmd.startedAt
      : null
    this.finish(waiter, {
      command: waiter.command,
      exitCode: cmd.exitCode,
      cwd: cmd.cwd,
      durationMs,
      timedOut: false,
    })
  }
}
