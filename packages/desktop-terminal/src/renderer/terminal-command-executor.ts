// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TerminalCommandExecutor — bridges the gap between the server-side
 * agent gateway and the client-side terminal surface.
 *
 * The agent runtime (server) wants to run commands in the user's visible
 * terminal. This module provides the renderer-side half:
 *
 *   1. Listens for incoming command requests (via IPC / postMessage)
 *   2. Routes them to the AgentTerminalBridge
 *   3. Returns the result (exit code + output) to the caller
 *
 * The server-side half is the `terminal_exec` gateway tool, which calls
 * the registered callback to reach this executor.
 *
 * Architecture:
 *
 *   LLM → gateway tool → IPC/HTTP → TerminalCommandExecutor → AgentTerminalBridge
 *                              ↑                                      ↓
 *                              └──────── result (exitCode, output) ───┘
 */

import type { Osc633Tracker, Command } from './osc633-tracker'
import type { AgentTerminalBridge, CommandResult } from './agent-terminal-bridge'

// ─── types ──────────────────────────────────────────────────────────────

export interface TerminalExecRequest {
  /** Unique request ID for correlating responses. */
  requestId: string
  /** The command to execute (shell text, e.g. "npm test"). */
  command: string
  /** Optional working directory to cd into first. */
  cwd?: string
  /** Max wait time in ms. Default: 120000 (2 minutes). */
  timeoutMs?: number
}

export interface TerminalExecResult {
  /** Correlates with the request. */
  requestId: string
  /** Whether execution succeeded (no timeout/error). */
  ok: boolean
  /** Exit code (null if interrupted or timed out). */
  exitCode: number | null
  /** Working directory where the command ran. */
  cwd: string | null
  /** Wall-clock duration in ms. */
  durationMs: number | null
  /** Whether the command timed out. */
  timedOut: boolean
  /** Error message if the executor couldn't dispatch (e.g. bridge not ready). */
  error?: string
}

export interface TerminalCommandExecutorOptions {
  /** The tracker for the active terminal. */
  tracker: Osc633Tracker
  /** The bridge for sending commands. */
  bridge: AgentTerminalBridge
  /** Max wait time for commands. Default: 120000. */
  defaultTimeoutMs?: number
  /** Maximum concurrent commands. Default: 1. (The bridge serializes anyway.) */
  maxConcurrent?: number
}

// ─── executor ───────────────────────────────────────────────────────────

/**
 * Manages incoming terminal command requests from the agent gateway.
 *
 * One instance per terminal surface. The gateway tool calls
 * `execute(request)` which blocks until the command finishes or times out.
 */
export class TerminalCommandExecutor {
  private tracker: Osc633Tracker
  private bridge: AgentTerminalBridge
  private defaultTimeoutMs: number
  private maxConcurrent: number
  private activeCount = 0
  private queue: Array<{
    request: TerminalExecRequest
    resolve: (result: TerminalExecResult) => void
  }> = []

  constructor(opts: TerminalCommandExecutorOptions) {
    this.tracker = opts.tracker
    this.bridge = opts.bridge
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000
    this.maxConcurrent = opts.maxConcurrent ?? 1
  }

  /**
   * Execute a terminal command request. Returns a promise that resolves
   * when the command completes or times out.
   *
   * If maxConcurrent is reached, the request is queued and will execute
   * when a slot opens.
   */
  execute(request: TerminalExecRequest): Promise<TerminalExecResult> {
    return new Promise<TerminalExecResult>((resolve) => {
      const task = { request, resolve }
      if (this.activeCount < this.maxConcurrent) {
        this.activeCount++
        this.runTask(task).then((result) => {
          this.activeCount--
          resolve(result)
          this.drainQueue()
        })
      } else {
        this.queue.push(task)
      }
    })
  }

  /**
   * Interrupt the currently running command by sending SIGINT.
   * Returns null if no command is running.
   */
  interruptCommand(): CommandResult | null {
    return this.bridge.interruptCommand()
  }

  /**
   * Send a POSIX signal to the terminal's PTY process.
   */
  sendSignal(sig: 'INT' | 'TERM'): void {
    this.bridge.sendSignal(sig)
  }

  /**
   * Check if the executor is ready (bridge is available).
   */
  isReady(): boolean {
    return this.bridge !== null
  }

  /**
   * Get the number of pending requests in the queue.
   */
  queueLength(): number {
    return this.queue.length
  }

  /**
   * Get the current CWD from the tracker.
   */
  getCurrentCwd(): string | null {
    return this.tracker.snapshot().cwd ?? null
  }

  // ─── internals ────────────────────────────────────────────────────

  private async runTask(task: {
    request: TerminalExecRequest
    resolve: (result: TerminalExecResult) => void
  }): Promise<TerminalExecResult> {
    const { request, resolve } = task
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs

    // If a specific cwd is requested, cd into it first
    if (request.cwd && request.cwd !== this.getCurrentCwd()) {
      await this.bridge.sendCommand(`cd ${shellQuote(request.cwd)}`)
    }

    try {
      // Temporarily increase the bridge timeout for this command
      const originalTimeout = (this.bridge as any).commandTimeoutMs
      ;(this.bridge as any).commandTimeoutMs = timeoutMs

      const result = await this.bridge.sendCommand(request.command)

      // Restore timeout
      ;(this.bridge as any).commandTimeoutMs = originalTimeout

      return {
        requestId: request.requestId,
        ok: true,
        exitCode: result.exitCode,
        cwd: result.cwd,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }
    } catch (err: any) {
      return {
        requestId: request.requestId,
        ok: false,
        exitCode: null,
        cwd: null,
        durationMs: null,
        timedOut: false,
        error: err?.message ?? String(err),
      }
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift()!
      this.activeCount++
      this.runTask(next).then((result) => {
        next.resolve(result)
        this.activeCount--
        this.drainQueue()
      })
    }
  }
}

// ─── factory ────────────────────────────────────────────────────────────

/**
 * Create a TerminalCommandExecutor bound to the current terminal.
 * Convenience wrapper for the common case.
 */
export function createTerminalCommandExecutor(opts: {
  tracker: Osc633Tracker
  bridge: AgentTerminalBridge
  defaultTimeoutMs?: number
}): TerminalCommandExecutor {
  return new TerminalCommandExecutor(opts)
}

// ─── helpers ────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  // If it's a simple path with no special chars, don't quote
  if (/^[a-zA-Z0-9._/\-]+$/.test(s)) return s
  // Escape single quotes and wrap in single quotes
  return `'${s.replace(/'/g, "'\\''")}'`
}
