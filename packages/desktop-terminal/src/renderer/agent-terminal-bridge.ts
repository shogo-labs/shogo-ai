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

// ─── bridge ─────────────────────────────────────────────────────────────

export class AgentTerminalBridge {
  private tracker: Osc633Tracker
  /** Wrapped send — always calls the latest client.send via a ref indirection. */
  private _sendRef: { fn: (data: string) => void; signal?: (sig: 'INT' | 'TERM') => void }
  private commandTimeoutMs: number
  private taskCounter = 0

  /** Commands we're currently waiting on (by command ID from the tracker). */
  private pending = new Map<number, {
    resolve: (result: CommandResult) => void
    command: string
    startedAt: number
    timer: ReturnType<typeof setTimeout> | null
    graceTimer?: ReturnType<typeof setTimeout>
  }>()

  /** Background tasks by ID. */
  private tasks = new Map<string, BackgroundTask>()

  /** The command ID currently being awaited by sendCommand (only one at a time). */
  private activeCommandId: number | null = null

  /** Streaming output callback registered by the current sendCommand. */
  private onOutputCallback: ((chunk: string) => void) | null = null

  private off: (() => void) | null = null
  private disposed = false

  constructor(opts: AgentTerminalBridgeOptions) {
    this.tracker = opts.tracker
    this._sendRef = { fn: opts.send, signal: opts.signal }
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 120_000

    // Listen for command-finished events to resolve pending promises
    this.off = this.tracker.on((ev) => {
      if (ev.kind === 'command-finished') {
        this.onCommandFinished(ev.command)
      }
    })
  }

  /**
   * Feed raw terminal output data into the active command's output accumulator.
   * Call this from the terminal's onData handler while a command is running.
   * ANSI sequences are stripped automatically.
   */
  feedOutput(data: string): void {
    // Strip ANSI escape sequences inline
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
      .replace(/\x1b[()][AB012]/g, '')
    if (stripped.length > 0 && this.activeCommandId != null) {
      for (const pending of this.pending.values()) {
        if (!('_output' in pending)) (pending as any)._output = ''
        ;(pending as any)._output += stripped
      }
      // Also call the streaming callback if one was registered
      this.onOutputCallback?.(stripped)
    }
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
   * within `timeoutMs` (default 120s).
   *
   * If `onOutput` is provided, ANSI-stripped output chunks are streamed
   * as the command runs (debounced, threshold-based).
   */
  sendCommand(command: string, options?: SendCommandOptions): Promise<CommandResult> {
    if (this.disposed) {
      return Promise.resolve({ command, exitCode: null, cwd: null, durationMs: null, timedOut: false })
    }

    const timeoutMs = options?.timeoutMs ?? this.commandTimeoutMs
    const onOutput = options?.onOutput
    this.onOutputCallback = onOutput ? (chunk) => { outputAccumulator += chunk; onOutput(chunk) } : null
    let outputAccumulator = ''

    return new Promise<CommandResult>((resolve) => {
      let resolved = false
      const safeResolve = (result: CommandResult) => {
        if (resolved) return
        resolved = true
        this.onOutputCallback = null
        resolve({ ...result, output: outputAccumulator || undefined })
      }

      // Fire the command — use the ref so we always call the latest send
      this._sendRef.fn(`${command}\r`)

      // Listen for the NEXT command-started event, which gives us
      // the tracker's Command ID to wait on.
      const offStart = this.tracker.on((ev) => {
        if (ev.kind === 'command-started') {
          offStart()

          const cmdId = ev.command.id
          this.activeCommandId = cmdId
          const timer = setTimeout(() => {
            this.pending.delete(cmdId)
            safeResolve({
              command,
              exitCode: null,
              cwd: ev.command.cwd,
              durationMs: timeoutMs,
              timedOut: true,
            })
          }, timeoutMs)

          this.pending.set(cmdId, {
            resolve: safeResolve,
            command,
            startedAt: ev.command.startedAt ?? Date.now(),
            timer,
          })
        }
      })
    })
  }

  /**
   * Send a command without waiting for completion.
   * Returns a BackgroundTask that can be polled or awaited later.
   */
  sendCommandBackground(command: string): BackgroundTask {
    const id = `bg_${++this.taskCounter}`
    this._sendRef.fn(`${command}\r`)

    let resolveResult: (result: CommandResult) => void
    let settled = false
    const promise = new Promise<CommandResult>((resolve) => {
      resolveResult = (r) => { if (!settled) { settled = true; resolve(r) } }
    })

    const offStart = this.tracker.on((ev) => {
      if (ev.kind === 'command-started') {
        offStart()

        const cmdId = ev.command.id
        const timer = setTimeout(() => {
          this.pending.delete(cmdId)
          this.tasks.delete(id)
          resolveResult!({
            command,
            exitCode: null,
            cwd: ev.command.cwd,
            durationMs: this.commandTimeoutMs,
            timedOut: true,
          })
        }, this.commandTimeoutMs)

        this.pending.set(cmdId, {
          resolve: (result) => {
            resolveResult!(result)
            this.tasks.delete(id)
          },
          command,
          startedAt: ev.command.startedAt ?? Date.now(),
          timer,
        })
      }
    })

    const task: BackgroundTask = {
      id,
      command,
      promise,
      dispose: () => {
        offStart()
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
   * The pending promise resolves with `exitCode: null` and `timedOut: false`.
   */
  interruptCommand(): CommandResult | null {
    const cmdId = this.activeCommandId
    if (cmdId == null) return null

    this.sendSignal('INT')
    // The pending promise will be resolved by onCommandFinished
    // when the tracker emits 'command-finished' with exitCode: null.
    // If the tracker doesn't emit (e.g. SIGINT kills the process silently),
    // we force-resolve after a short grace period.
    const pending = this.pending.get(cmdId)
    if (pending) {
      const graceTimer = setTimeout(() => {
        if (this.pending.has(cmdId)) {
          if (pending.timer) clearTimeout(pending.timer)
          this.pending.delete(cmdId)
          this.activeCommandId = null
          pending.resolve({
            command: pending.command,
            exitCode: null,
            cwd: null,
            durationMs: null,
            timedOut: false,
          })
        }
      }, 2000)
      // Store grace timer so we can cancel it if command-finished fires normally
      pending.graceTimer = graceTimer
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
   * Clean up listeners and reject pending promises.
   */
  dispose(): void {
    this.disposed = true
    this.off?.()
    this.off = null
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.graceTimer) clearTimeout(pending.graceTimer)
    }
    this.pending.clear()
    this.activeCommandId = null
    for (const task of this.tasks.values()) {
      task.dispose()
    }
    this.tasks.clear()
  }

  // ─── internals ──────────────────────────────────────────────────

  private onCommandFinished(cmd: Command): void {
    const pending = this.pending.get(cmd.id)
    if (!pending) return

    if (pending.timer) clearTimeout(pending.timer)
    if (pending.graceTimer) clearTimeout(pending.graceTimer)
    this.pending.delete(cmd.id)
    if (this.activeCommandId === cmd.id) this.activeCommandId = null

    const durationMs = (cmd.startedAt != null && cmd.finishedAt != null)
      ? cmd.finishedAt - cmd.startedAt
      : null

    pending.resolve({
      command: pending.command,
      exitCode: cmd.exitCode,
      cwd: cmd.cwd,
      durationMs,
      timedOut: false,
      output: (pending as any)._output || undefined,
    })
  }
}
