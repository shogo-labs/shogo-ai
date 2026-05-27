// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Control-plane types for the Desktop PTY transport.
 *
 * Lives in @shogo/pty-core so both endpoints can import the SAME
 * declarations:
 *   - apps/desktop/src/pty-host/*        (Electron utilityProcess / main)
 *   - packages/desktop-terminal/src/*    (renderer-side client)
 *
 * Wire encoding: JSON only on this channel. The data plane uses the
 * binary PTY protocol (see ./pty-protocol.ts) over a MessagePort.
 *
 * IMPORTANT: keep this file type-only (no runtime values that pull
 * platform-specific deps). Both ends of the bridge must be able to
 * import it freely.
 */

export interface SpawnOptions {
  /**
   * Desktop renderers may pass projectId and let Electron main resolve the
   * managed workspace path. The pty-host always receives a normalized cwd.
   */
  projectId?: string
  shell?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export interface SessionInfo {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  pid: number | null
  createdAt: number
  lastSeq: number
}

export type ControlEvent =
  | { kind: 'session:exit'; id: string; code: number | null; signal: string | null; reason: string }
  | { kind: 'host:ready'; version: string }
  | { kind: 'host:log'; level: 'info' | 'warn' | 'error'; message: string }

/** Reasons that should stop the renderer's reconnect loop. */
export const DESKTOP_TERMINAL_CLOSE_REASONS: ReadonlyArray<string> = [
  'pty:exited',
  'pty:killed',
  'pty:shutdown',
  'no-session',
]

/** Default min/max dimensions enforced server-side; mirrored here for
 * client-side validation (cheap defence-in-depth). */
export const DESKTOP_COLS_MIN = 1
export const DESKTOP_COLS_MAX = 1000
export const DESKTOP_ROWS_MIN = 1
export const DESKTOP_ROWS_MAX = 1000
