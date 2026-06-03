// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for debug-ipc.ts. Split for unit-testability under bun (the
 * main module imports `electron`, which can't be loaded in a test env).
 */

/**
 * Strict validator for the WebSocket URL we'll open from the main process.
 *
 * Only allow:
 *   ws://127.0.0.1[:port]/<path>
 *   ws://localhost[:port]/<path>
 *
 * No wss://, no ::1 (we don't enable IPv6 inspector by default), no other
 * hostnames.  This is enforced because the renderer-side caller hands us
 * the URL — we never want to accidentally open a CDP connection to a
 * remote host because the v8 stderr was tampered with.
 */
export function isLoopbackWsUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'ws:') return false
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false
  // Port must be numeric (URL constructor allows empty string for default 80).
  if (url.port === '') return false
  const portNum = Number(url.port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return false
  return true
}
