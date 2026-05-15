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
 * `ReadDirectoryChangesW` on the workspace root, etc.).
 *
 * Windows resilience strategy (POSIX paths are unaffected — `rename(2)`
 * doesn't care about open handles):
 *
 *   1. Per-call retries with exponential backoff. Many transient locks
 *      (AV scan of a single bundle chunk, chokidar's awaitWriteFinish
 *      stat polling) clear within a second; longer retries cover slower
 *      disks, large assets being scanned, and heavy AV configurations.
 *      The Windows budget is intentionally an order of magnitude
 *      larger than POSIX to handle real workspaces with multi-megabyte
 *      assets (e.g. GLB / video files in `public/`).
 *
 *   2. Workspace-scoped commit mutex. PreviewManager and
 *      CanvasBuildManager both call `commitBuildOutput` against the
 *      same `<workspaceDir>/dist/` at boot — without serialization
 *      they can win/lose `dist.prev/` cleanup against each other and
 *      one's promoted output gets clobbered by the other's rotation.
 *      The mutex queues callers per workspace so the rotation
 *      sequence is observed atomically end-to-end.
 *
 *   3. Force-replace fallback. If `rename(dist, dist.prev)` exhausts
 *      retries we still have a freshly-built `<staging>/` ready to
 *      ship. Rather than refusing to swap (which leaves the new
 *      build orphaned and the user staring at the previous build),
 *      we fall back to `rmSync(dist, {recursive,force})` followed
 *      by `rename(staging, dist)`. This trades the rollback dir for
 *      forward progress: if the user needs to revert they always have
 *      git, but they can't get a successful build to render at all
 *      without the new dist landing.
 *
 * All helpers swallow errors with a logged warning rather than throwing:
 * a swap failure is recoverable (the stale `dist/` keeps serving) and
 * must never crash the runtime.
 */

import {
  existsSync as fsExistsSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  type RmOptions,
  type PathLike,
} from 'fs'
import { join } from 'path'

// Indirection so tests can swap in failure-injecting fs functions
// without monkey-patching `node:fs` (which is a readonly ESM
// namespace under Bun and rejects assignment). Production code path
// goes straight through to the real fs functions; only
// `__setFsImplForTest` rewires these refs.
let renameSync: (from: PathLike, to: PathLike) => void = fsRenameSync
let rmSync: (path: PathLike, options?: RmOptions) => void = fsRmSync
let existsSync: (path: PathLike) => boolean = fsExistsSync

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

// POSIX retry schedule. Cumulative ~1.6s. AV scans and in-flight
// `readFileSync` calls against `dist/` typically clear within a few
// hundred ms on POSIX (and rename(2) doesn't care about open files
// anyway), so this short tail is enough to cover the rare cases where
// `ENOTEMPTY` shows up from a parallel `rmSync` walking the same dir.
const RETRY_DELAYS_POSIX_MS = [25, 50, 100, 200, 400, 400, 400] as const

// Windows retry schedule. Cumulative ~12s. Sized to outlast Defender
// real-time scans on multi-megabyte assets dropped into `public/`
// (e.g. a 172 MB GLB) which routinely hold a handle for several
// seconds, plus the worst-case awaitWriteFinish window from chokidar.
// The progression starts as aggressive as POSIX so the common case
// (sub-second clears) remains fast, then ramps to second-scale waits
// for the long tail. Past ~12s the lock is almost certainly not
// transient and the force-replace fallback below will kick in.
const RETRY_DELAYS_WIN32_MS = [25, 50, 100, 200, 400, 800, 1500, 2000, 3000, 4000] as const

const DEFAULT_RETRY_DELAYS_MS: readonly number[] =
  process.platform === 'win32' ? RETRY_DELAYS_WIN32_MS : RETRY_DELAYS_POSIX_MS

// Mutable so test helpers can install a tight schedule (e.g. all-zero
// delays) without having to wait the full Windows ~12s budget every
// time a regression test exhausts retries. Production code never
// touches this variable directly — only `withFsRetry` reads it and
// `__setRetryDelaysForTest` writes it.
let currentRetryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS

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
 * empirically clear on their own within the budgeted window.
 *
 * Exported for testing. Production callers should not import this
 * directly; use `commitBuildOutput` / `cleanupStagingOutput` instead.
 */
export function withFsRetry<T>(op: () => T): T {
  const schedule = currentRetryDelaysMs
  let lastErr: any
  for (let i = 0; i <= schedule.length; i++) {
    try {
      return op()
    } catch (err: any) {
      lastErr = err
      if (!TRANSIENT_FS_ERRORS.has(err?.code) || i === schedule.length) throw err
      sleepSync(schedule[i])
    }
  }
  throw lastErr
}

/**
 * Workspace-scoped commit mutex. PreviewManager (`expo export` /
 * `vite build` for the iframe seed) and CanvasBuildManager (the
 * canvas-driven rebuilds) both call `commitBuildOutput` against the
 * same `<workspaceDir>/dist/` and `<workspaceDir>/dist.prev/`. Without
 * serialization they race on:
 *
 *   • `rmSync(dist.prev)` — if A finished step 1 and is mid-rename(B's
 *     step 2 may delete-as-it-arrives the dir A's about to rename
 *     into.
 *   • `rename(dist, dist.prev)` — only one can succeed; the loser sees
 *     dist disappear and may then `rename(staging, dist)` clobbering
 *     the winner's promoted output.
 *
 * The map keys on `workspaceDir` so distinct workspaces (cloud
 * multi-tenant case) don't share a queue. Each entry is the
 * tail Promise of the queue; new callers chain onto it and update the
 * tail. Solves only the *concurrent* case — nothing here helps with
 * out-of-process locks (AV, browser, chokidar OS-level handle), which
 * is what the per-call retries + force-replace fallback are for.
 */
const commitQueues = new Map<string, Promise<void>>()

async function withWorkspaceLock<T>(workspaceDir: string, op: () => T): Promise<T> {
  const prev = commitQueues.get(workspaceDir) ?? Promise.resolve()
  let resolveTail!: () => void
  const tail = new Promise<void>((r) => { resolveTail = r })
  commitQueues.set(workspaceDir, tail)
  try {
    await prev
    return op()
  } finally {
    resolveTail()
    // If we're still the tail (no one chained after us), drop the
    // entry so the map doesn't grow unbounded across many short-lived
    // workspaces.
    if (commitQueues.get(workspaceDir) === tail) {
      commitQueues.delete(workspaceDir)
    }
  }
}

/**
 * Atomically swap `<workspaceDir>/<stagingName>/` into
 * `<workspaceDir>/dist/`. The previous `dist/` (if any) is moved aside
 * to `dist.prev/` and then removed, so a failure mid-swap leaves the
 * old build in `dist.prev/` for manual recovery rather than silently
 * losing it.
 *
 * Synchronous return value preserved for callers that aren't async.
 * Returns `true` when the swap completed (new dist is in place),
 * `false` otherwise.
 */
export function commitBuildOutput(workspaceDir: string, stagingName: string): boolean {
  return commitBuildOutputImpl(workspaceDir, stagingName)
}

/**
 * Async variant that respects the workspace-scoped commit mutex.
 * Preferred for callers that can `await` (PreviewManager,
 * CanvasBuildManager). The sync `commitBuildOutput` is retained for
 * tests and any legacy synchronous callers; mixing the two is safe
 * because the underlying impl is reentrant per-workspace from a
 * single-threaded event loop's perspective, but only the async path
 * benefits from cross-manager serialization.
 */
export async function commitBuildOutputAsync(
  workspaceDir: string,
  stagingName: string,
): Promise<boolean> {
  return withWorkspaceLock(workspaceDir, () => commitBuildOutputImpl(workspaceDir, stagingName))
}

function commitBuildOutputImpl(workspaceDir: string, stagingName: string): boolean {
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
  let rotated = false
  if (existsSync(dist)) {
    try {
      withFsRetry(() => renameSync(dist, prev))
      rotated = true
    } catch (err: any) {
      // Final retry exhausted. On Windows this is overwhelmingly an
      // out-of-process file lock (Defender, browser keep-alive on
      // dist/index.html, chokidar OS handle) that simply isn't going
      // to clear inside a build cycle. Fall through to the
      // force-replace path below rather than abandoning the
      // freshly-built staging dir.
      console.warn(
        `[${LOG_PREFIX}] could not move ${dist} to ${prev} after retries (${err?.code ?? 'UNKNOWN'}: ${err?.message ?? err}) — falling back to in-place replace`,
      )
    }
  }

  if (rotated || !existsSync(dist)) {
    // Happy path (or first-ever build): staging → dist via rename.
    try {
      withFsRetry(() => renameSync(staging, dist))
    } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] could not move ${staging} to ${dist}: ${err?.message ?? err}`)
      // Try to roll back so the runtime keeps serving the previous build
      // rather than nothing at all.
      if (rotated) {
        try {
          if (existsSync(prev)) withFsRetry(() => renameSync(prev, dist))
        } catch (rollbackErr: any) {
          console.error(
            `[${LOG_PREFIX}] rollback failed; previous build is in ${prev}: ${rollbackErr?.message ?? rollbackErr}`,
          )
        }
      }
      return false
    }
  } else {
    // Fallback: rotation failed but dist still exists (locked).
    // Force-delete dist in place — `rmSync` on Windows can sometimes
    // succeed where `renameSync` fails because individual file deletes
    // only need delete-share permission, while a directory rename
    // requires no concurrent enumeration of the parent. If even
    // rmSync can't break through the lock, there's nothing else we
    // can do without restarting the runtime, so we surface the
    // failure and leave the existing dist serving.
    try {
      withFsRetry(() => rmSync(dist, { recursive: true, force: true }))
    } catch (err: any) {
      console.error(
        `[${LOG_PREFIX}] force-replace failed: could not remove locked ${dist} (${err?.code ?? 'UNKNOWN'}: ${err?.message ?? err}). New build remains in ${staging}; previous build keeps serving.`,
      )
      return false
    }
    try {
      withFsRetry(() => renameSync(staging, dist))
      console.warn(
        `[${LOG_PREFIX}] force-replaced ${dist} (rollback dir not preserved this cycle).`,
      )
    } catch (err: any) {
      console.error(
        `[${LOG_PREFIX}] force-replace promote failed: ${err?.message ?? err}. Workspace dist/ is now empty until the next successful build.`,
      )
      return false
    }
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

/**
 * Test-only: drain the workspace commit queue map. Production code
 * never needs this — the map self-cleans as queues drain. Tests need
 * it because they construct fresh workspaces in afterEach and don't
 * want the previous test's tail Promise to anchor a stale queue
 * entry that delays the next test's await.
 */
export function __resetCommitQueuesForTest(): void {
  commitQueues.clear()
}

/**
 * Test-only: swap the retry schedule. Returns a restore function the
 * caller MUST invoke (typically in `afterEach`) so subsequent tests
 * see the platform-default schedule again. Used to skip the multi-
 * second Windows backoff in regression tests that intentionally
 * exhaust the budget — the *count* of attempts is what matters there,
 * not the wall time between them.
 */
export function __setRetryDelaysForTest(delays: readonly number[]): () => void {
  const before = currentRetryDelaysMs
  currentRetryDelaysMs = delays
  return () => {
    currentRetryDelaysMs = before
  }
}

/**
 * Test-only: read the active retry schedule's length so tests that
 * pin "calls === schedule.length + 1" stay correct across the
 * platform-asymmetric default (POSIX: 7 retries, Windows: 10).
 */
export function __getRetryScheduleLengthForTest(): number {
  return currentRetryDelaysMs.length
}

/**
 * Test-only: override the fs primitives this module uses for the
 * rotation/replace dance. Returns a restore function that the caller
 * MUST invoke (typically in `afterEach`) to put the real fs back.
 *
 * We expose this as an explicit seam — instead of relying on
 * `mock.module('fs', …)` — because:
 *   1. Bun's ESM namespace for `node:fs` is readonly, so direct
 *      property assignment (`fs.renameSync = mockedFn`) throws
 *      `TypeError: Attempted to assign to readonly property`.
 *   2. `mock.module` hot-swaps the module for *all* importers in the
 *      same test process, which can quietly affect other helpers and
 *      makes test isolation fragile.
 * A typed setter that flips three internal `let` bindings is the
 * minimum-surface alternative that lets tests drive the
 * EPERM/EBUSY paths deterministically.
 */
export function __setFsImplForTest(impl: {
  renameSync?: (from: PathLike, to: PathLike) => void
  rmSync?: (path: PathLike, options?: RmOptions) => void
  existsSync?: (path: PathLike) => boolean
}): () => void {
  const before = { renameSync, rmSync, existsSync }
  if (impl.renameSync) renameSync = impl.renameSync
  if (impl.rmSync) rmSync = impl.rmSync
  if (impl.existsSync) existsSync = impl.existsSync
  return () => {
    renameSync = before.renameSync
    rmSync = before.rmSync
    existsSync = before.existsSync
  }
}

/** Default staging directory name used by callers that don't need to pick their own. */
export const DEFAULT_STAGING_DIR = 'dist.staging'
