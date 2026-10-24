// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stopping the local API on purpose (SHO-181).
 *
 * macOS/Linux: SIGTERM to the child's process group, which the API already
 * handles as a real shutdown. Windows has no SIGTERM — the old code ran
 * `taskkill /PID … /T /F` straight away, so the API and every runtime under it
 * were killed mid-write and the supervisor logged the forced kill as `code=1`,
 * the "the API crashed" line in the issue.
 *
 * So on win32 we now ask first (the token-guarded
 * `POST /api/local/system/shutdown`), wait for the child to exit, and only then
 * force the tree. Shared by the update fast path and a normal quit.
 *
 * Electron-free: the sequencing is unit-tested with fake signals and a fake
 * exit watcher (see `__tests__/api-stop.test.ts`).
 */

export type StopReason = 'update' | 'quit' | 'restart'

export interface ApiStopRequest {
  platform: string
  reason: StopReason
  /**
   * Ask the API to shut itself down (win32). Resolves true when it accepted —
   * the request only has to be delivered; the wait for exit does the rest.
   */
  requestGracefulStop: () => Promise<boolean>
  /** SIGTERM the process group (non-win32). */
  signalTerm: () => void
  /** Kill the tree for real: `taskkill /T /F`, or SIGKILL to the group. */
  forceKill: () => void
  /** Resolves true when the child is gone, false on timeout. */
  waitForExit: (timeoutMs: number) => Promise<boolean>
  timeoutMs?: number
  log?: (message: string) => void
}

export const DEFAULT_API_STOP_TIMEOUT_MS = 5_000

export interface ApiStopResult {
  /** The child exited on its own after the request. */
  graceful: boolean
  /** We had to kill it. */
  forced: boolean
}

export async function stopApiProcess(request: ApiStopRequest): Promise<ApiStopResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_API_STOP_TIMEOUT_MS
  const log = request.log ?? ((message: string) => console.log(message))

  if (request.platform === 'win32') {
    // No SIGTERM: the polite request is an HTTP call the API answers itself.
    log(`[Desktop] Asking the API to stop (reason=${request.reason})…`)
    const asked = await request.requestGracefulStop().catch(() => false)
    if (!asked) log('[Desktop] Graceful stop request was not accepted — the tree will be killed')
    if (await request.waitForExit(timeoutMs)) {
      log(`[Desktop] API server stopped on request (reason=${request.reason})`)
      return { graceful: true, forced: false }
    }
    log(`[Desktop] Shutdown timeout (${timeoutMs}ms) reached, killing the process tree`)
    request.forceKill()
    return { graceful: false, forced: true }
  }

  request.signalTerm()
  if (await request.waitForExit(timeoutMs)) {
    log(`[Desktop] API server stopped on request (reason=${request.reason}, graceful=true)`)
    return { graceful: true, forced: false }
  }
  log(`[Desktop] Shutdown timeout (${timeoutMs}ms) reached, sending SIGKILL`)
  request.forceKill()
  return { graceful: false, forced: true }
}

/**
 * The one line a deliberate stop logs, instead of the `exited: code=1` that
 * reads like a crash. `code`/`signal` stay in the line because they are still
 * evidence: a graceful stop should show `code=0`, and a forced one does not.
 */
export function formatIntentionalStopLog(reason: StopReason, code: number | null, signal: string | null): string {
  return `[Desktop] API server stopped on request (reason=${reason}, code=${code}, signal=${signal})`
}
