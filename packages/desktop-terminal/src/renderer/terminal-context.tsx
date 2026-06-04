// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TerminalContext — shared React context that bridges the terminal surface
 * (Osc633Tracker, AgentTerminalBridge) with the chat panel and other consumers.
 *
 * This solves the component-tree isolation problem: the terminal lives in
 * XtermView/ShogoTerminalSurface, while ChatPanel is a sibling in _layout.tsx.
 * Neither can reach the other's ref tree. TerminalContext provides a shared
 * subscription point so any consumer can:
 *
 *   1. Build auto-context (ContextAggregator needs the tracker)
 *   2. Execute agent commands (AgentTerminalBridge needs the tracker + send)
 *   3. Show background task status (BackgroundTaskStatus needs active tasks)
 *   4. Read terminal state (cwd, active command, etc.)
 *
 * The provider is mounted once by the terminal surface. Consumers call
 * `useTerminalContext()` to access the bridge.
 */

import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react'
import type { Osc633Tracker, Command } from './osc633-tracker'
import type { AgentTerminalBridge, CommandResult, BackgroundTask } from './agent-terminal-bridge'

// ─── public types ───────────────────────────────────────────────────────

export interface TerminalContextValue {
  /** Whether the terminal surface is mounted and the tracker is ready. */
  ready: boolean

  /** The current tracker instance (null before mount). */
  tracker: Osc633Tracker | null

  /** The current bridge instance (null before mount). */
  bridge: AgentTerminalBridge | null

  /** Current working directory from the tracker's latest cwd event. */
  cwd: string | null

  /** Snapshot of recent commands. */
  recentCommands: Command[]

  /** Active background tasks (may be empty). */
  backgroundTasks: BackgroundTask[]

  // ─── actions ───────────────────────────────────────────────────────

  /**
   * Send a command via the agent terminal bridge and await completion.
   * Returns null if the terminal is not ready.
   */
  sendCommand?: (command: string) => Promise<CommandResult | null>

  /**
   * Send a command without waiting for completion.
   * Returns null if the terminal is not ready.
   */
  sendCommandBackground?: (command: string) => BackgroundTask | null

  /**
   * Register a listener for tracker events.
   * Returns an unsubscribe function.
   */
  onTrackerEvent?: (listener: (event: any) => void) => () => void
}

// ─── context ────────────────────────────────────────────────────────────

const TerminalContext = createContext<TerminalContextValue>({
  ready: false,
  tracker: null,
  bridge: null,
  cwd: null,
  recentCommands: [],
  backgroundTasks: [],
})

export interface TerminalContextProviderProps {
  children: ReactNode
  tracker: Osc633Tracker | null
  bridge: AgentTerminalBridge | null
  cwd?: string | null
}

/**
 * Provider that exposes the terminal surface's tracker and bridge to all
 * descendants. Mount this inside ShogoTerminalSurface (or equivalent).
 */
export function TerminalContextProvider({
  children,
  tracker,
  bridge,
  cwd: initialCwd,
}: TerminalContextProviderProps) {
  const trackerRef = useRef(tracker)
  const bridgeRef = useRef(bridge)
  trackerRef.current = tracker
  bridgeRef.current = bridge

  const sendCommand = useCallback(async (command: string): Promise<CommandResult | null> => {
    if (!bridgeRef.current) return null
    return bridgeRef.current.sendCommand(command)
  }, [])

  const sendCommandBackground = useCallback((command: string): BackgroundTask | null => {
    if (!bridgeRef.current) return null
    return bridgeRef.current.sendCommandBackground(command)
  }, [])

  const onTrackerEvent = useCallback((listener: (event: any) => void): (() => void) => {
    if (!trackerRef.current) return () => {}
    return trackerRef.current.on(listener)
  }, [])

  const value: TerminalContextValue = {
    ready: tracker !== null,
    tracker,
    bridge,
    cwd: initialCwd ?? null,
    recentCommands: tracker ? tracker.snapshot().commands.slice(-10) : [],
    backgroundTasks: bridge ? [] : [],
    sendCommand,
    sendCommandBackground,
    onTrackerEvent,
  }

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  )
}

/**
 * Hook to access the terminal context. Returns the context value.
 * The `ready` flag indicates whether the terminal surface is mounted.
 */
export function useTerminalContext(): TerminalContextValue {
  return useContext(TerminalContext)
}

/**
 * Create a TerminalContextValue from explicit instances (for tests
 * or non-React consumers that need the same interface).
 */
export function createTerminalContextValue(opts: {
  tracker: Osc633Tracker
  bridge: AgentTerminalBridge
}): TerminalContextValue {
  const { tracker, bridge } = opts
  return {
    ready: true,
    tracker,
    bridge,
    cwd: tracker.snapshot().cwd ?? null,
    recentCommands: tracker.snapshot().commands.slice(-10),
    backgroundTasks: [],
    sendCommand: (cmd) => bridge.sendCommand(cmd),
    sendCommandBackground: (cmd) => bridge.sendCommandBackground(cmd),
    onTrackerEvent: (listener) => tracker.on(listener),
  }
}
