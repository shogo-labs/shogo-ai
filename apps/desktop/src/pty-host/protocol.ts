// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wire format between Electron main (PtyHostClient) and the PtyHost
 * `utilityProcess`. Both sides import this module — it is the single
 * source of truth for message shapes.
 *
 * Two channels run in parallel:
 *
 *   1. **Control channel** — JSON via `parentPort.postMessage` and
 *      `child.postMessage`. Low-rate (spawn/kill/list/snapshot). Always
 *      goes through main. Used by `PtyHostClient.*` methods.
 *
 *   2. **Data channel** — one `MessageChannelMain` per attached client.
 *      Live PTY output and writes flow over the channel's MessagePorts
 *      directly between renderer ↔ host, bypassing main's event loop on
 *      the hot path. Established via `attach()` in the control channel,
 *      then main hands the renderer-side port to the renderer via
 *      `webContents.postMessage(channel, msg, [port])` and the host-side
 *      port via `child.postMessage(msg, [port])`.
 *
 * The data-channel framing reuses `@shogo/pty-core` (DATA / EXIT / TRUNC).
 *
 * Control messages are JSON-safe — no transferables, no `Uint8Array`s on
 * this channel. Bytes always travel over the data channel.
 */

// ─── control: main → host ───────────────────────────────────────────────

export interface SpawnOptions {
  /** Absolute path to the shell binary OR a name resolvable on PATH. */
  shell: string
  /** Argv after the shell binary. May be empty. */
  args: string[]
  /** Absolute working directory. */
  cwd: string
  /** Full environment. Caller is responsible for inheriting / sanitising. */
  env: Record<string, string>
  /** Initial PTY size. Clamped to 1..1000 on the host side. */
  cols: number
  rows: number
  /** Optional opaque tag for restore-from-snapshot flows (Phase 9). */
  restoreId?: string
  /** Stable workspace key used for snapshots/restores. */
  workspaceHash?: string
  /** Optional profile id from the renderer profile store. */
  profileId?: string
}

export interface SessionInfo {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  pid: number | null
  /** Wall-clock ms when spawn() returned. */
  createdAt: number
  /** Last seq emitted to scrollback (monotonic). */
  lastSeq: number
}

export type ControlRequest =
  | { kind: 'spawn'; reqId: number; opts: SpawnOptions }
  | { kind: 'write'; reqId: number; id: string; text: string }
  | { kind: 'resize'; reqId: number; id: string; cols: number; rows: number }
  | { kind: 'signal'; reqId: number; id: string; sig: 'INT' | 'TERM' | 'KILL' }
  | { kind: 'kill'; reqId: number; id: string }
  | { kind: 'list'; reqId: number }
  | { kind: 'attach'; reqId: number; id: string; sinceSeq: number }
  | { kind: 'detach'; reqId: number; id: string; channelId: string }
  | { kind: 'snapshots:list'; reqId: number; workspaceHash: string }
  | { kind: 'snapshots:restore'; reqId: number; workspaceHash: string; id: string }
  | { kind: 'snapshots:discard'; reqId: number; workspaceHash: string; id: string }
  | { kind: 'snapshots:flush'; reqId: number }

// ─── control: host → main ───────────────────────────────────────────────

export type ControlResponse =
  | { kind: 'spawn:ok'; reqId: number; session: SessionInfo }
  | { kind: 'list:ok'; reqId: number; sessions: SessionInfo[] }
  | { kind: 'attach:ok'; reqId: number; id: string; channelId: string; latestSeq: number }
  | { kind: 'snapshots:list:ok'; reqId: number; snapshots: SnapshotSummary[] }
  | { kind: 'snapshots:restore:ok'; reqId: number; session: SessionInfo }
  | { kind: 'ok'; reqId: number }
  | { kind: 'err'; reqId: number; code: string; message: string }

export interface SnapshotSummary {
  id: string
  workspaceHash: string
  cwd: string
  shell: string
  profileId?: string
  writtenAt: number
  ringBytes: number
}

/**
 * Events the host pushes spontaneously (no reqId). Live data goes over
 * data-channel ports, not this channel — these are lifecycle signals only.
 */
export type ControlEvent =
  | { kind: 'session:exit'; id: string; code: number | null; signal: string | null; reason: string }
  | { kind: 'session:reap'; id: string; reason: 'idle' | 'detach-grace' | 'max-age' | 'shutdown' }
  | { kind: 'host:ready'; version: string }
  | { kind: 'host:beat'; t: number }
  | { kind: 'host:unresponsive'; lastBeatAt: number }
  | { kind: 'host:log'; level: 'info' | 'warn' | 'error'; message: string }

export type HostInbound = ControlRequest
export type HostOutbound = ControlResponse | ControlEvent

/** Conservative cap so a malicious renderer can't allocate a giant termios. */
export const COLS_MIN = 1
export const COLS_MAX = 1000
export const ROWS_MIN = 1
export const ROWS_MAX = 1000

export function clampDim(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  const i = n | 0
  if (i < lo) return lo
  if (i > hi) return hi
  return i
}

/** Discriminator for routing in main.ts (the same window dispatches
 * multiple kinds of postMessage traffic — pty, fs, recording, …). */
export const PTY_PORT_CHANNEL = 'shogo:pty:port' as const
