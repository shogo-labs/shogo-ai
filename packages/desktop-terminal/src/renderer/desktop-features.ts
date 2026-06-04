// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Capability detection + the shape of the contextBridge API exposed by
 * apps/desktop/src/preload-terminal.ts.
 *
 * The renderer-side code in this package talks to Electron exclusively
 * through `window.shogoDesktopTerminal` — never via direct Electron
 * imports. Lets us unit-test by setting `globalThis.shogoDesktopTerminal`
 * to a stub.
 */

import type {
  ControlEvent,
  SessionInfo,
  SpawnOptions,
  SnapshotSummary,
} from '@shogo/pty-core'
import type { LlmClient } from './cmd-k-popover'

/** What the preload bridges into the renderer. */
export interface ShogoDesktopTerminalBridge {
  spawn(opts: SpawnOptions): Promise<SessionInfo>
  write(id: string, text: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  signal(id: string, sig: 'INT' | 'TERM' | 'KILL'): Promise<void>
  kill(id: string): Promise<void>
  list(): Promise<SessionInfo[]>
  listSnapshots?(workspaceHash: string): Promise<SnapshotSummary[]>
  restoreSession?(workspaceHash: string, snapshotId: string): Promise<{ newSessionId: string; session?: SessionInfo }>
  discardSnapshot?(workspaceHash: string, snapshotId: string): Promise<void>
  restartHost?(): Promise<void>
  /**
   * Open the data plane for an existing session.
   *
   * Returns a `MessagePort`-shaped object (the real MessagePort transferred
   * across the contextBridge boundary). The port fires `message` events
   * for inbound frames and accepts `postMessage` for outbound writes.
   *
   * The returned port is the renderer-side half of a `MessageChannelMain`;
   * the host-side half is wired to the PtySession's data fanout by main.
   */
  attach(id: string, sinceSeq: number): Promise<{
    port: MessagePortLike
    channelId: string
    latestSeq: number
  }>
  detach(id: string, channelId: string): Promise<void>
  /** Subscribe to control-channel events (session:exit, host:log…). */
  onEvent(cb: (ev: ControlEvent) => void): () => void
  /** Push structured OSC633 command history to the main-process context bridge. */
  publishTerminalContext?(payload: {
    sessionId: string
    cwd: string | null
    content: string
  }): Promise<void>
  /** Fired when the agent spawns a background (∞ Shogo) terminal tab. */
  onAgentTerminalSpawned?(cb: (payload: {
    sessionId: string
    terminalLabel: string
    cwd: string | null
  }) => void): () => void
  llm?: LlmClient & {
    openChatWithContext?(markdown: string): Promise<void>
  }
}

export type { ControlEvent }

/**
 * A subset of the real DOM `MessagePort`. We use only the bits we need
 * so unit tests can drop in a fake.
 */
export interface MessagePortLike {
  postMessage(message: ArrayBuffer | Uint8Array): void
  addEventListener(type: 'message', listener: (ev: { data: ArrayBuffer | Uint8Array }) => void): void
  removeEventListener(type: 'message', listener: (ev: { data: ArrayBuffer | Uint8Array }) => void): void
  start?(): void
  close(): void
}

/** True when this code is running inside an Electron renderer that has
 * had the desktop-terminal preload script loaded. */
export function isDesktop(): boolean {
  const g = globalThis as { shogoDesktopTerminal?: unknown }
  return typeof g.shogoDesktopTerminal !== 'undefined' && g.shogoDesktopTerminal !== null
}

/** Throws if not in Desktop — used by call sites that legitimately
 * require the bridge to exist. */
export function getDesktopBridge(): ShogoDesktopTerminalBridge {
  const g = globalThis as { shogoDesktopTerminal?: ShogoDesktopTerminalBridge }
  if (!g.shogoDesktopTerminal) {
    throw new Error(
      'shogoDesktopTerminal bridge missing — Desktop terminal called from a ' +
      'non-Electron context, or preload-terminal.ts failed to load.',
    )
  }
  return g.shogoDesktopTerminal
}
