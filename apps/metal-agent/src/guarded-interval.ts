// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A `setInterval` for async sweeps that must never overlap themselves.
 *
 * The agent's periodic sweeps (idle reaper, writable-state export) walk every
 * live VM sequentially and do S3 uploads and Firecracker snapshots per project,
 * so a single pass routinely outlasts its own interval on a busy host. A plain
 * `setInterval` then stacks passes, and because each pass takes its own snapshot
 * of the VM map they collide on the same projects: the loser of a per-project
 * singleflight throws (`project ... not assigned`, once the winner has already
 * suspended and removed it) and duplicate S3 work piles up. Production ran ~880
 * such errors per host in 45 minutes with an unguarded reaper, and no pass ever
 * survived long enough to log its result.
 *
 * Skipping a tick is always the right call here: the work is a sweep over
 * current state, so the in-flight pass already covers anything this tick would
 * have found, and the next tick re-reads state from scratch.
 */
export interface GuardedInterval {
  /** Stops the timer. Does not interrupt a pass already running. */
  stop(): void
  /** True while a pass is running — for assertions and diagnostics. */
  readonly running: boolean
  /** Count of ticks dropped because a pass was still running. */
  readonly skipped: number
}

/**
 * Run `task` every `intervalMs`, dropping any tick that lands while the previous
 * pass is still in flight. `label` names the sweep in the skip warning.
 *
 * `task` rejections are swallowed after being logged: the guard's job is to keep
 * the timer alive and unpoisoned, so callers that care about outcomes should
 * handle their own results inside `task`.
 */
export function guardedInterval(
  label: string,
  intervalMs: number,
  task: () => Promise<unknown>,
  log: Pick<Console, 'warn' | 'error'> = console,
): GuardedInterval {
  let inFlight = false
  let skipped = 0

  const timer = setInterval(() => {
    if (inFlight) {
      skipped++
      log.warn(`[metal-agent] ${label} still running from the previous tick — skipping`)
      return
    }
    inFlight = true
    let settled: Promise<unknown>
    try {
      settled = Promise.resolve(task())
    } catch (err: any) {
      // A task that throws synchronously must still clear the flag, or the sweep
      // would be wedged off for the lifetime of the process.
      inFlight = false
      log.error(`[metal-agent] ${label} error:`, err?.message ?? err)
      return
    }
    void settled
      .catch((err: any) => log.error(`[metal-agent] ${label} error:`, err?.message ?? err))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)

  return {
    stop: () => clearInterval(timer),
    get running() {
      return inFlight
    },
    get skipped() {
      return skipped
    },
  }
}
