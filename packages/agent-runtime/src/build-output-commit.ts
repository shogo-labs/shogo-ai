// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Atomic build-output commit helpers.
 *
 * The runtime serves the static SPA from `<workspaceDir>/dist/`. Build tools
 * (`expo export`, `vite build`) historically wrote directly into that
 * directory and cleared it first, which left `dist/` empty for several
 * seconds and caused 404s on page refresh — and a permanent 404 if the
 * build then failed. These helpers let callers stage the build into
 * `<workspaceDir>/<staging>/` and atomically swap it into `<dist>/` only
 * after a successful build, so the previous good build keeps serving
 * throughout.
 *
 * The commit sequence:
 *   1. Remove any stale `<workspaceDir>/dist.prev/` left behind by an
 *      earlier crash.
 *   2. Rename `<workspaceDir>/dist/` → `dist.prev/` (skipped if missing).
 *   3. Rename `<workspaceDir>/<staging>/` → `dist/`.
 *   4. Best-effort remove `<workspaceDir>/dist.prev/`.
 *
 * Steps 2 and 3 form the only window where a request could see a
 * transient state — both are sub-millisecond `rename(2)` calls on POSIX.
 * On Windows the same operations go through `MoveFileEx`, which fails
 * with `EPERM` / `EBUSY` if any process holds an open handle inside the
 * tree (antivirus real-time scanning, the static handler reading from
 * `dist/` for an in-flight preview request, chokidar's recursive
 * `ReadDirectoryChangesW` on the workspace root, etc.). To stay
 * resilient on Windows we wrap each fs call in a short retry loop with
 * exponential backoff — those locks typically clear within a few
 * hundred milliseconds.
 *
 * All helpers swallow errors with a logged warning rather than throwing:
 * a swap failure is recoverable (the stale `dist/` keeps serving) and
 * must never crash the runtime.
 */

import { existsSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

const LOG_PREFIX = 'build-output-commit'
const PREV_DIR_NAME = 'dist.prev'
const FINAL_DIR_NAME = 'dist'

// Error codes raised by Windows when a directory rename / remove races
// another process holding a handle inside the tree — typically antivirus
// real-time scanning the freshly-built JS chunks, the static handler
// reading `dist/` for an in-flight preview request, or chokidar's
// recursive OS-level watch on the workspace root pinning child
// directories. POSIX rename(2) does not care about open handles, so
// these effectively never fire there.
const TRANSIENT_FS_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

// Cumulative backoff in ms: ~25, 50, 100, 200, 400, 400, 400 → ~1.6s
// total before giving up. AV scans and in-flight `readFileSync` calls
// against `dist/` typically clear within a few hundred ms; the long tail
// covers slower disks and heavier AV configs.
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 400, 400] as const

// Shared sleep buffer reused across retries. Atomics.wait gives us a
// clean synchronous sleep without burning a CPU core in a busy loop —
// callers of these helpers are already synchronous (post-build commit)
// so blocking the thread briefly is fine.
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

/**
 * Run a synchronous fs operation with exponential backoff on transient
 * Windows file-locking errors. Non-transient errors (ENOENT, EISDIR,
 * etc.) bubble out on the first attempt — we only retry the codes that
 * empirically clear on their own within a second.
 *
 * Exported for testing. Production callers should not import this
 * directly; use `commitBuildOutput` / `cleanupStagingOutput` instead.
 */
export function withFsRetry<T>(op: () => T): T {
  let lastErr: any
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return op()
    } catch (err: any) {
      lastErr = err
      if (!TRANSIENT_FS_ERRORS.has(err?.code) || i === RETRY_DELAYS_MS.length) throw err
      sleepSync(RETRY_DELAYS_MS[i])
    }
  }
  throw lastErr
}

/**
 * Atomically swap `<workspaceDir>/<stagingName>/` into
 * `<workspaceDir>/dist/`. The previous `dist/` (if any) is moved aside
 * to `dist.prev/` and then removed, so a failure mid-swap leaves the
 * old build in `dist.prev/` for manual recovery rather than silently
 * losing it.
 *
 * Returns `true` when the swap completed (new dist is in place),
 * `false` otherwise. Callers don't need the return value for
 * correctness — it's exposed for tests and metrics.
 */
export function commitBuildOutput(workspaceDir: string, stagingName: string): boolean {
  const staging = join(workspaceDir, stagingName)
  const dist = join(workspaceDir, FINAL_DIR_NAME)
  const prev = join(workspaceDir, PREV_DIR_NAME)

  if (!existsSync(staging)) {
    console.warn(`[${LOG_PREFIX}] commit aborted: ${staging} does not exist`)
    return false
  }

  // Clear any leftover dist.prev from a prior crashed swap. renameSync
  // requires a non-existent target on Windows.
  try {
    if (existsSync(prev)) withFsRetry(() => rmSync(prev, { recursive: true, force: true }))
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not remove stale ${prev}: ${err?.message ?? err}`)
    // Try to continue — the rename below will fail loudly if prev
    // really is in the way.
  }

  // Move the existing dist out of the way. Skipped on first-ever build.
  if (existsSync(dist)) {
    try {
      withFsRetry(() => renameSync(dist, prev))
    } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] could not move ${dist} to ${prev}: ${err?.message ?? err}`)
      return false
    }
  }

  // Promote the staging dir to dist.
  try {
    withFsRetry(() => renameSync(staging, dist))
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not move ${staging} to ${dist}: ${err?.message ?? err}`)
    // Try to roll back so the runtime keeps serving the previous build
    // rather than nothing at all.
    try {
      if (existsSync(prev)) withFsRetry(() => renameSync(prev, dist))
    } catch (rollbackErr: any) {
      console.error(
        `[${LOG_PREFIX}] rollback failed; previous build is in ${prev}: ${rollbackErr?.message ?? rollbackErr}`,
      )
    }
    return false
  }

  // Best-effort cleanup of the previous build. A failure here just
  // wastes disk; the new dist is already serving.
  try {
    if (existsSync(prev)) withFsRetry(() => rmSync(prev, { recursive: true, force: true }))
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not remove ${prev} after swap: ${err?.message ?? err}`)
  }

  return true
}

/**
 * Remove a leftover staging directory after a failed build. Safe to
 * call when the directory is absent. Best-effort: any failure is
 * logged but never thrown.
 */
export function cleanupStagingOutput(workspaceDir: string, stagingName: string): void {
  const staging = join(workspaceDir, stagingName)
  if (!existsSync(staging)) return
  try {
    withFsRetry(() => rmSync(staging, { recursive: true, force: true }))
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not remove staging ${staging}: ${err?.message ?? err}`)
  }
}

/** Default staging directory name used by callers that don't need to pick their own. */
export const DEFAULT_STAGING_DIR = 'dist.staging'
