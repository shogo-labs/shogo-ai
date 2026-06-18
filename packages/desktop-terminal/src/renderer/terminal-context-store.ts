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
  /**
   * Identifies which terminal published this context. Multiple terminals
   * (splits, agent tab + user tab) each publish under their own id so one
   * terminal's unmount cannot wipe another's context. Omit for single-terminal
   * callers — they share a default key.
   */
  sessionId?: string
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

// ─── global, session-keyed backing store ────────────────────────────────
// Use globalThis as backing store so that even if two module instances exist
// (e.g. ShogoTerminalSurface imports directly, _layout.tsx imports via the
// package barrel), they share the same data. Snapshots are keyed by session id
// so concurrent terminals don't clobber each other; `activeId` selects which
// one consumers (chat / agent tools) currently target.

const GLOBAL_KEY = '__shogoTerminalContext'
const DEFAULT_SESSION_KEY = '__default__'

interface BackingStore {
  sessions: Map<string, TerminalContextSnapshot>
  activeId: string | null
  listeners: Set<TerminalContextListener>
}

function createBacking(): BackingStore {
  return { sessions: new Map(), activeId: null, listeners: new Set() }
}

function getGlobalBacking(): BackingStore {
  const g = globalThis as any
  const existing = g[GLOBAL_KEY]
  // Guard against a stale (pre-session-keyed) shape after hot reload.
  if (!existing || !(existing.sessions instanceof Map)) {
    g[GLOBAL_KEY] = createBacking()
  }
  return g[GLOBAL_KEY]
}

// ─── store ──────────────────────────────────────────────────────────────

class TerminalContextStore {
  private store: BackingStore

  /**
   * @param backing Provide an isolated backing store (tests). Defaults to the
   *   process-wide global backing so multiple module copies stay in sync.
   */
  constructor(backing?: BackingStore) {
    this.store = backing ?? getGlobalBacking()
  }

  /**
   * Publish a terminal's context. Called by the terminal surface on mount /
   * tracker change. The published session becomes the active one. Multiple
   * terminals can be published concurrently under distinct session ids.
   */
  publish(snapshot: TerminalContextSnapshot): void {
    const id = snapshot.sessionId ?? DEFAULT_SESSION_KEY
    this.store.sessions.set(id, snapshot)
    this.store.activeId = id
    this.notify()
  }

  /**
   * Withdraw one terminal's context (on unmount). Only removes the given
   * session — other terminals stay published. If the withdrawn session was
   * active, the most recently published remaining session is promoted.
   */
  withdraw(sessionId?: string): void {
    const id = sessionId ?? DEFAULT_SESSION_KEY
    if (!this.store.sessions.delete(id)) return
    if (this.store.activeId === id) {
      let newest: TerminalContextSnapshot | null = null
      for (const snap of this.store.sessions.values()) {
        if (!newest || snap.publishedAt > newest.publishedAt) newest = snap
      }
      this.store.activeId = newest ? (newest.sessionId ?? DEFAULT_SESSION_KEY) : null
    }
    this.notify()
  }

  /**
   * Select which published terminal consumers target. No-op if unknown.
   */
  setActiveSession(sessionId: string): void {
    if (!this.store.sessions.has(sessionId)) return
    this.store.activeId = sessionId
    this.notify()
  }

  /**
   * Get the active terminal's snapshot synchronously. Returns null if no
   * terminal is published.
   */
  current(): TerminalContextSnapshot | null {
    const id = this.store.activeId
    if (id == null) return null
    return this.store.sessions.get(id) ?? null
  }

  /**
   * Subscribe to context changes. Returns an unsubscribe function.
   */
  subscribe(listener: TerminalContextListener): () => void {
    this.store.listeners.add(listener)
    return () => { this.store.listeners.delete(listener) }
  }

  /**
   * Check if any terminal is currently published and ready.
   */
  isReady(): boolean {
    return this.current() !== null
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
    const ctx = this.current()
    if (!ctx) return userText

    const aggregator = new ContextAggregator({
      tracker: ctx.tracker,
      editor: opts?.editor ?? { getActiveFile: async () => null },
      git: opts?.git ?? { getStatus: async () => null },
      diagnostics: opts?.diagnostics ?? { getDiagnostics: async () => [] },
      getCommandOutput: (cmd) => ctx.bridge.getCommandOutput(cmd.id),
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
    const ctx = this.current()
    if (!ctx) return []
    return ctx.tracker.snapshot().commands.slice(-limit)
  }

  /**
   * Get the current working directory.
   */
  getCwd(): string | null {
    return this.current()?.cwd ?? null
  }

  /**
   * Send a command through the terminal bridge and await completion.
   * Returns null if the terminal is not mounted.
   */
  async sendCommand(command: string): Promise<ReturnType<AgentTerminalBridge['sendCommand']> | null> {
    const ctx = this.current()
    if (!ctx) return Promise.resolve(null)
    return ctx.bridge.sendCommand(command)
  }

  /**
   * Interrupt the currently running command (sends SIGINT).
   * Returns null if no terminal mounted or no command running.
   */
  interruptCommand(): CommandResult | null {
    return this.current()?.bridge.interruptCommand() ?? null
  }

  /**
   * Send a POSIX signal to the terminal's PTY process.
   */
  sendSignal(sig: 'INT' | 'TERM'): void {
    this.current()?.bridge.sendSignal(sig)
  }

  // ─── internals ────────────────────────────────────────────────────

  private notify(): void {
    const snap = this.current()
    for (const listener of this.store.listeners) {
      listener(snap)
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
 * Each instance gets its own backing store — no global state shared.
 */
export function createTerminalContextStore(): TerminalContextStore {
  return new TerminalContextStore(createBacking())
}
