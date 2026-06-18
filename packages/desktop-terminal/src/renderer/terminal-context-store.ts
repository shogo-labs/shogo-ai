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

// ─── global singleton bridge ────────────────────────────────────────────
// Use globalThis as backing store so that even if two module instances
// exist (e.g. ShogoTerminalSurface imports directly, _layout.tsx imports
// via the package barrel), they share the same data.

const GLOBAL_KEY = '__shogoTerminalContext'

interface GlobalStore {
  snapshot: TerminalContextSnapshot | null
  listeners: Set<TerminalContextListener>
}

function getGlobalStore(): GlobalStore {
  const g = globalThis as any
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { snapshot: null, listeners: new Set() } as GlobalStore
  }
  return g[GLOBAL_KEY]
}

// ─── store ──────────────────────────────────────────────────────────────

class TerminalContextStore {
  private get store(): GlobalStore { return getGlobalStore() }

  /**
   * Publish the current terminal context. Called by the terminal surface
   * on mount / tracker change / unmount.
   */
  publish(snapshot: TerminalContextSnapshot): void {
    this.store.snapshot = snapshot
    this.notify()
  }

  /**
   * Withdraw the terminal context. Called on terminal surface unmount.
   */
  withdraw(): void {
    this.store.snapshot = null
    this.notify()
  }

  /**
   * Get the current snapshot synchronously. Returns null if the terminal
   * surface is not mounted.
   */
  current(): TerminalContextSnapshot | null {
    return this.store.snapshot
  }

  /**
   * Subscribe to context changes. Returns an unsubscribe function.
   */
  subscribe(listener: TerminalContextListener): () => void {
    this.store.listeners.add(listener)
    return () => { this.store.listeners.delete(listener) }
  }

  /**
   * Check if the terminal surface is currently mounted and ready.
   */
  isReady(): boolean {
    return this.store.snapshot !== null
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
    const ctx = this.store.snapshot
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
    const ctx = this.store.snapshot
    if (!ctx) return []
    return ctx.tracker.snapshot().commands.slice(-limit)
  }

  /**
   * Get the current working directory.
   */
  getCwd(): string | null {
    return this.store.snapshot?.cwd ?? null
  }

  /**
   * Send a command through the terminal bridge and await completion.
   * Returns null if the terminal is not mounted.
   */
  async sendCommand(command: string): Promise<ReturnType<AgentTerminalBridge['sendCommand']> | null> {
    if (!this.store.snapshot) return Promise.resolve(null)
    return this.store.snapshot.bridge.sendCommand(command)
  }

  /**
   * Interrupt the currently running command (sends SIGINT).
   * Returns null if no terminal mounted or no command running.
   */
  interruptCommand(): CommandResult | null {
    if (!this.store.snapshot) return null
    return this.store.snapshot.bridge.interruptCommand()
  }

  /**
   * Send a POSIX signal to the terminal's PTY process.
   */
  sendSignal(sig: 'INT' | 'TERM'): void {
    this.store.snapshot?.bridge.sendSignal(sig)
  }

  // ─── internals ────────────────────────────────────────────────────

  private notify(): void {
    for (const listener of this.store.listeners) {
      listener(this.store.snapshot)
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
