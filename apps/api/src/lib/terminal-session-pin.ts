// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pin the runtime that hosts a terminal bridge socket.
 *
 * While a PTY socket is open its runtime counts as doing active work, so the
 * warm-preview LRU skips it — an eviction sweep must never tear down the
 * runtime the user is typing into (SHO-107: the Windows smoke terminal died
 * with "1011 Connection ended" because the sweep evicted its runtime 205 ms
 * after the PTY opened).
 *
 * Both composers wire this — `local-server.ts` (desktop and docker/self-host
 * local mode, the surface that broke) and `server.ts` (cloud compatibility) —
 * so it lives here once rather than being mirrored per composer.
 */
import type { PtyPodBridgeData } from './pty-pod-bridge'
import type { IRuntimeManager } from './runtime/types'

/**
 * Count a terminal bridge socket opening (+1) or closing (-1) against the
 * runtime that hosts it. Best-effort: a manager without the hook (or one that
 * throws) must never break the socket itself.
 */
export function countTerminalSession(
  runtimeManager: Pick<IRuntimeManager, 'noteTerminalSession'> | null | undefined,
  data: Pick<PtyPodBridgeData, 'projectId'> | null | undefined,
  delta: 1 | -1,
): void {
  const projectId = data?.projectId
  if (!projectId) return
  try {
    runtimeManager?.noteTerminalSession?.(projectId, delta)
  } catch (err: any) {
    console.warn('[TerminalProxy] terminal-session pin failed:', err?.message ?? err)
  }
}
