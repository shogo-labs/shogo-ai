// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Process-level error handlers for the API process.
 *
 * Both composers need these, and only the cloud one had them (SHO-482). Bun
 * exits on an unhandled rejection, so a single escaped promise in the desktop
 * API killed it; the supervisor restarted it into the same failure until it
 * gave up and the app never opened again.
 *
 * An exception that escapes Hono's boundary is logged, not fatal: a route bug
 * or a dropped database connection is not a reason to take down every chat on
 * the process. OOM and the like still crash, which is what the runtime wants.
 */

let installed = false

export function installProcessErrorHandlers(tag = 'API'): void {
  if (installed) return
  installed = true

  process.on('unhandledRejection', (reason: any) => {
    // AbortSignal.timeout() DOMExceptions are noisy and expected during cold
    // starts / retries — log a single line instead of the full object.
    if (reason?.name === 'TimeoutError' || reason?.name === 'AbortError') {
      console.warn(`[${tag}] Suppressed timeout rejection:`, reason.message)
      return
    }
    console.error(`[${tag}] Unhandled promise rejection:`, reason?.message || reason)
    if (reason?.stack) {
      console.error(`[${tag}] Stack:`, reason.stack)
    }
  })

  process.on('uncaughtException', (err: Error) => {
    console.error(`[${tag}] Uncaught exception:`, err?.message)
    if (err?.stack) {
      console.error(`[${tag}] Stack:`, err.stack)
    }
    // For truly fatal errors (OOM, etc.), still crash — but DB/network errors should not kill the process
  })
}

/** Test-only: let a suite install the handlers again. */
export function resetProcessErrorHandlersForTests(): void {
  installed = false
}
