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
 * transient state — both are sub-millisecond `rename(2)` calls on POSIX
 * and `MoveFileEx` on Windows.
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
    if (existsSync(prev)) rmSync(prev, { recursive: true, force: true })
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not remove stale ${prev}: ${err?.message ?? err}`)
    // Try to continue — the rename below will fail loudly if prev
    // really is in the way.
  }

  // Move the existing dist out of the way. Skipped on first-ever build.
  if (existsSync(dist)) {
    try {
      renameSync(dist, prev)
    } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] could not move ${dist} to ${prev}: ${err?.message ?? err}`)
      return false
    }
  }

  // Promote the staging dir to dist.
  try {
    renameSync(staging, dist)
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not move ${staging} to ${dist}: ${err?.message ?? err}`)
    // Try to roll back so the runtime keeps serving the previous build
    // rather than nothing at all.
    try {
      if (existsSync(prev)) renameSync(prev, dist)
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
    if (existsSync(prev)) rmSync(prev, { recursive: true, force: true })
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
    rmSync(staging, { recursive: true, force: true })
  } catch (err: any) {
    console.warn(`[${LOG_PREFIX}] could not remove staging ${staging}: ${err?.message ?? err}`)
  }
}

/** Default staging directory name used by callers that don't need to pick their own. */
export const DEFAULT_STAGING_DIR = 'dist.staging'
