// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The local API's own shutdown, reachable from a route (SHO-181).
 *
 * On macOS the desktop stops this process with SIGTERM to its process group, and
 * the signal handler in `local-server.ts` runs a real shutdown: workers stop, the
 * runtimes write their final markers, the server closes. Windows has no SIGTERM,
 * so the desktop used `taskkill /T /F` and the API (and every runtime under it)
 * died mid-write — and the supervisor read that forced kill as `code=1`.
 *
 * The entry point registers its shutdown function here; the token-guarded
 * `POST /api/local/system/shutdown` route calls it. A registry rather than a
 * direct import because the route module must not pull the API entry point (and
 * with it the whole composer) into every test that mounts the local routes.
 */

export type LocalShutdownReason = 'update' | 'quit' | 'restart'

type ShutdownHandler = (reason: LocalShutdownReason) => Promise<void>

let handler: ShutdownHandler | null = null

/** Called once by the local entry point, with its real shutdown. */
export function registerLocalShutdownHandler(fn: ShutdownHandler): void {
  handler = fn
}

/** True when a shutdown can actually be run (the entry point has booted). */
export function hasLocalShutdownHandler(): boolean {
  return handler !== null
}

/**
 * Stop the local API the way a signal would. Returns false when nothing is
 * registered — the caller then falls back to the forced kill it used before.
 */
export async function runLocalShutdown(reason: LocalShutdownReason): Promise<boolean> {
  if (!handler) {
    console.warn('[LocalAPI] shutdown requested but no handler is registered — nothing to stop')
    return false
  }
  await handler(reason)
  return true
}

/** Test seam. */
export function resetLocalShutdownHandler(): void {
  handler = null
}
