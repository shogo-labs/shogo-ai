// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TerminalContextStore — module-level singleton that bridges the terminal
 * surface with the chat panel and other cross-tree consumers.
 *
 * The terminal surface publishes its tracker + bridge on mount (and
 * withdraws on unmount). Consumers (chat panel, agent loop, etc.) read
 * the current state at call time. This avoids the React context limitation
 * where providers and consumers must be in the same component tree.
 *
 * Pattern: same as subagentStreamStore — module singleton, subscribe for
 * reactive updates, read synchronously for immediate access.
 *
 * Usage:
 *   // Publisher (ShogoTerminalSurface):
 *   import { terminalContextStore } from '@shogo/desktop-terminal'
 *   terminalContextStore.publish({ tracker, bridge, cwd })
 *   // On unmount:
 *   terminalContextStore.withdraw()
 *
 *   // Consumer (ChatPanel / enrichMessage):
 *   import { terminalContextStore } from '@shogo/desktop-terminal'
 *   const ctx = terminalContextStore.current()
 *   if (ctx) { // use ctx.tracker, ctx.bridge }
 */

import type { Osc633Tracker, Command } from './osc633-tracker'
import type { AgentTerminalBridge, CommandResult } from './agent-terminal-bridge'
import { ContextAggregator, serializeContext, formatContextMessage } from './context-aggregator'

// ─── types ──────────────────────────────────────────────────────────────

export interface TerminalContextSnapshot {
  /** The tracker for the active terminal. */
  tracker: Osc633Tracker
  /** The bridge for sending commands. */
  bridge: AgentTerminalBridge
  /** Current working directory. */
  cwd: string | null
  /** Timestamp of when this was published. */
  publishedAt: number
}

export type TerminalContextListener = (snapshot: TerminalContextSnapshot | null) => void

// ─── store ──────────────────────────────────────────────────────────────

class TerminalContextStore {
  private current_: TerminalContextSnapshot | null = null
  private listeners = new Set<TerminalContextListener>()

  /**
   * Publish the current terminal context. Called by the terminal surface
   * on mount / tracker change / unmount.
   */
  publish(snapshot: TerminalContextSnapshot): void {
    this.current_ = snapshot
    this.notify()
  }

  /**
   * Withdraw the terminal context. Called on terminal surface unmount.
   */
  withdraw(): void {
    this.current_ = null
    this.notify()
  }

  /**
   * Get the current snapshot synchronously. Returns null if the terminal
   * surface is not mounted.
   */
  current(): TerminalContextSnapshot | null {
    return this.current_
  }

  /**
   * Subscribe to context changes. Returns an unsubscribe function.
   */
  subscribe(listener: TerminalContextListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Check if the terminal surface is currently mounted and ready.
   */
  isReady(): boolean {
    return this.current_ !== null
  }

  // ─── convenience methods ──────────────────────────────────────────

  /**
   * Build auto-context for a chat message using the current terminal state.
   * Returns the enriched message text, or the original if no context available.
   *
   * This is the primary entry point for the enrichMessage flow:
   *   const enriched = await terminalContextStore.enrichMessage(userText)
   */
  async enrichMessage(userText: string, opts?: {
    editor?: { getActiveFile(): Promise<any> }
    git?: { getStatus(): Promise<any> }
    diagnostics?: { getDiagnostics(): Promise<any> }
  }): Promise<string> {
    const ctx = this.current_
    if (!ctx) return userText

    const aggregator = new ContextAggregator({
      tracker: ctx.tracker,
      editor: opts?.editor ?? { getActiveFile: async () => null },
      git: opts?.git ?? { getStatus: async () => null },
      diagnostics: opts?.diagnostics ?? { getDiagnostics: async () => [] },
    })

    const aggregated = await aggregator.collect()
    if (aggregated.sources.length === 0) return userText

    const contextBlock = serializeContext(aggregated)
    return formatContextMessage(contextBlock, userText)
  }

  /**
   * Get recent terminal commands (last N).
   */
  getRecentCommands(limit: number = 5): Command[] {
    const ctx = this.current_
    if (!ctx) return []
    return ctx.tracker.snapshot().commands.slice(-limit)
  }

  /**
   * Get the current working directory.
   */
  getCwd(): string | null {
    return this.current_?.cwd ?? null
  }

  /**
   * Send a command through the terminal bridge and await completion.
   * Returns null if the terminal is not mounted.
   */
  async sendCommand(command: string): Promise<ReturnType<AgentTerminalBridge['sendCommand']> | null> {
    if (!this.current_) return Promise.resolve(null)
    return this.current_.bridge.sendCommand(command)
  }

  /**
   * Interrupt the currently running command (sends SIGINT).
   * Returns null if no terminal mounted or no command running.
   */
  interruptCommand(): CommandResult | null {
    if (!this.current_) return null
    return this.current_.bridge.interruptCommand()
  }

  /**
   * Send a POSIX signal to the terminal's PTY process.
   */
  sendSignal(sig: 'INT' | 'TERM'): void {
    this.current_?.bridge.sendSignal(sig)
  }

  // ─── internals ────────────────────────────────────────────────────

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.current_)
    }
  }
}

/**
 * Module-level singleton. One store per app instance.
 * The terminal surface publishes, consumers read.
 */
export const terminalContextStore = new TerminalContextStore()

/**
 * Factory function for creating isolated store instances (for tests).
 */
export function createTerminalContextStore(): TerminalContextStore {
  return new TerminalContextStore()
}
