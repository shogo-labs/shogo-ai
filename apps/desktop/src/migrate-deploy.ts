// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `prisma migrate deploy` with a timeout that a cold start can actually meet.
 *
 * The timeout was 30 s. A cold `bun x prisma` start — no module cache, a virus
 * scanner reading every file, a spinning disk — took 28 s on one run and over
 * 30 s on another, so the deploy was killed, `main.log` recorded only the FATAL
 * line, and the app refused to open (SHO-482). 120 s is roughly four times the
 * slowest observed run; a genuine failure still reports its own error long
 * before that.
 *
 * A kill at the timeout is retried once, because the second attempt reuses the
 * OS file cache the first one warmed. Any other failure is final: retrying a
 * P3005 or a malformed migration only delays the recovery dialog.
 */

/** Budget for one `migrate deploy`. See the module note for why it is this big. */
export const MIGRATE_DEPLOY_TIMEOUT_MS = 120_000

export interface MigrateDeployAttempt {
  ok: boolean
  stdout: string
  stderr: string
  error?: any
  /** The attempt was killed at the timeout rather than failing on its own. */
  timedOut: boolean
  elapsedMs: number
  /** 1 for the first attempt, 2 for the retry. */
  number: number
}

export interface MigrateDeployDeps {
  /**
   * Run one `migrate deploy`. Must throw exactly as `execSync` does: `stdout`
   * and `stderr` on the error, plus `code` / `signal` when it was killed.
   */
  run: (command: string, timeoutMs: number) => string
}

const asText = (value: unknown): string =>
  value == null ? '' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value)

/** Did this attempt fail because it ran out of time? */
export function isTimeout(err: any, elapsedMs: number, timeoutMs: number): boolean {
  if (!err) return false
  if (err.code === 'ETIMEDOUT') return true
  if (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') return true
  // Bun's execSync does not always set `code`; a run that spent its whole budget
  // before failing was killed by the timeout.
  return elapsedMs >= timeoutMs
}

export function runMigrateDeployOnce(
  command: string,
  deps: MigrateDeployDeps,
  timeoutMs: number = MIGRATE_DEPLOY_TIMEOUT_MS,
  number = 1,
): MigrateDeployAttempt {
  const startedAt = Date.now()
  try {
    const stdout = deps.run(command, timeoutMs)
    return {
      ok: true,
      stdout: asText(stdout),
      stderr: '',
      timedOut: false,
      elapsedMs: Date.now() - startedAt,
      number,
    }
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt
    return {
      ok: false,
      stdout: asText(err?.stdout),
      stderr: asText(err?.stderr),
      error: err,
      timedOut: isTimeout(err, elapsedMs, timeoutMs),
      elapsedMs,
      number,
    }
  }
}

/**
 * Run the deploy, retrying once when the first attempt was killed at the
 * timeout. Returns the last attempt.
 */
export function runMigrateDeploy(
  command: string,
  deps: MigrateDeployDeps,
  timeoutMs: number = MIGRATE_DEPLOY_TIMEOUT_MS,
): MigrateDeployAttempt {
  const first = runMigrateDeployOnce(command, deps, timeoutMs, 1)
  if (first.ok || !first.timedOut) return first
  return runMigrateDeployOnce(command, deps, timeoutMs, 2)
}

/**
 * The lines to write to `main.log` when the deploy failed.
 *
 * `code`, `signal`, elapsed time and the full output, always — including an
 * empty stdout/stderr, which is the case that used to leave a FATAL line with
 * nothing beside it and made this issue guesswork.
 */
export function describeMigrateFailure(attempt: MigrateDeployAttempt): string[] {
  const err = attempt.error
  const code = err?.code === undefined || err?.code === null ? '(none)' : String(err.code)
  const signal = err?.signal ? String(err.signal) : '(none)'
  return [
    `migrate deploy failed: code=${code} signal=${signal} elapsed=${attempt.elapsedMs}ms timedOut=${attempt.timedOut} attempt=${attempt.number}`,
    `migrate deploy stdout: ${attempt.stdout.trim() || '(empty)'}`,
    `migrate deploy stderr: ${attempt.stderr.trim() || '(empty)'}`,
  ]
}
