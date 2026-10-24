// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keep macOS Spotlight out of the local workspaces directory (SHO-152).
 *
 * `~/Library/Application Support/Shogo/data/workspaces` holds one checkout per
 * project, each with its own `node_modules`. Spotlight indexes all of it
 * (`mdfind -name package.json` returned 633k hits) and re-indexes after every
 * install or build, so `mds_stores` plus a couple of dozen `mdworker`s burn
 * more than one core whenever an agent works.
 *
 * What actually works on macOS (probed on 26.5.2, see the card):
 *   - `.metadata_never_index` is IGNORED below the volume root, so it cannot
 *     exclude a directory that lives under `~/Library`.
 *   - A `.noindex` name suffix IS honoured — and renaming an already-indexed
 *     directory purges its existing entries without a manual reindex.
 *   - Spotlight does not follow symlinks, so a `workspaces` symlink pointing
 *     at `workspaces.noindex` stays invisible to it.
 *   - Hidden directories are skipped already (`.bun-cache`,
 *     `.shogo-worktrees`), so nothing else needs moving.
 *
 * Per-path exclusion via `mdutil` or the privacy plist needs root, which a
 * desktop app must not ask for. So on darwin we rename the real directory to
 * `workspaces.noindex` and leave `workspaces` behind as a symlink: a
 * same-volume `rename(2)` is instant, keeps inodes (so a process whose cwd is
 * the old path keeps working) and keeps absolute paths already persisted in
 * the DB, chat history and pty records valid.
 *
 * Pure `node:fs` + `node:path` on purpose — no Electron import, so every state
 * below is unit-testable (`src/__tests__/spotlight-exclusion.test.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'

export const LEGACY_WORKSPACES_DIRNAME = 'workspaces'
export const NOINDEX_WORKSPACES_DIRNAME = 'workspaces.noindex'

/** Why the workspaces dir could not be excluded from Spotlight indexing. */
export type SpotlightBlockedReason = 'both-exist' | 'foreign-symlink' | 'rename-failed'

export interface WorkspacesDirDecision {
  /** Absolute path every caller should use for the workspaces dir. */
  workspacesDir: string
  /** True when the path we hand out is (or just became) a `.noindex` dir. */
  excluded: boolean
  /** True when this call performed the rename. */
  migrated: boolean
  /**
   * Set when the directory is not fully protected — the desktop shows its
   * one-time Spotlight hint in that case. `both-exist` still points the app at
   * the excluded dir; the leftover legacy dir is what keeps being indexed.
   */
  blocked: SpotlightBlockedReason | null
  /** Human-readable detail for the log (and the hint). */
  detail?: string
}

export interface EnsureWorkspacesNoIndexOptions {
  /** Defaults to `process.platform`. Injected so tests can pin each branch. */
  platform?: NodeJS.Platform
  /** Defaults to `console.log` with a `[Desktop]` prefix. */
  log?: (message: string) => void
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

function readlinkOrNull(target: string): string | null {
  try {
    return fs.readlinkSync(target)
  } catch {
    return null
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Make sure `data/workspaces` is not indexed by Spotlight, and return the path
 * the app should use. Idempotent: every launch after the first is a no-op.
 *
 * Live states handled (all covered by tests):
 *   - non-darwin            → `data/workspaces`, nothing touched
 *   - fresh install         → `workspaces.noindex` created + symlink
 *   - legacy real dir       → renamed to `workspaces.noindex` + symlink
 *   - already migrated      → no-op
 *   - both as real dirs     → `.noindex` wins, nothing merged or deleted
 *   - foreign symlink       → left alone, legacy path kept
 *   - rename fails          → legacy path kept, hint shown
 */
export function ensureWorkspacesNoIndex(
  dataDir: string,
  options: EnsureWorkspacesNoIndexOptions = {},
): WorkspacesDirDecision {
  const platform = options.platform ?? process.platform
  const log = options.log ?? ((message: string) => console.log(`[Desktop] ${message}`))

  const legacyDir = path.join(dataDir, LEGACY_WORKSPACES_DIRNAME)
  const noIndexDir = path.join(dataDir, NOINDEX_WORKSPACES_DIRNAME)
  const keepLegacy = (
    blocked: SpotlightBlockedReason,
    detail: string,
  ): WorkspacesDirDecision => ({ workspacesDir: legacyDir, excluded: false, migrated: false, blocked, detail })

  if (platform !== 'darwin') {
    return { workspacesDir: legacyDir, excluded: false, migrated: false, blocked: null }
  }

  const legacyStat = lstatOrNull(legacyDir)
  const noIndexStat = lstatOrNull(noIndexDir)

  if (legacyStat?.isSymbolicLink()) {
    const target = readlinkOrNull(legacyDir)
    if (target !== null && path.resolve(dataDir, target) === path.resolve(noIndexDir)) {
      if (!noIndexStat) {
        // The real dir was moved aside by hand and the back-compat link now
        // dangles. Recreate it rather than handing out a broken path.
        fs.mkdirSync(noIndexDir, { recursive: true })
        log(`${legacyDir} was a dangling symlink; recreated ${noIndexDir}`)
      }
      return { workspacesDir: noIndexDir, excluded: true, migrated: false, blocked: null }
    }
    // A user who relocated their data dir may have symlinked this elsewhere.
    // Never replace a link we did not create.
    log(`leaving ${legacyDir} alone: it points at ${target ?? '(unreadable)'}, not ${NOINDEX_WORKSPACES_DIRNAME}`)
    return keepLegacy('foreign-symlink', target ?? 'unreadable symlink')
  }

  if (legacyStat && noIndexStat) {
    // Two real dirs: the excluded one holds the projects this install has been
    // using, so use it — but never merge or delete either. The leftover legacy
    // dir is exactly why the hint still needs to show.
    log(`both ${LEGACY_WORKSPACES_DIRNAME} and ${NOINDEX_WORKSPACES_DIRNAME} exist — using ${noIndexDir} and leaving ${legacyDir} untouched`)
    return { workspacesDir: noIndexDir, excluded: true, migrated: false, blocked: 'both-exist', detail: legacyDir }
  }

  if (!legacyStat) {
    // Fresh install (or the legacy dir was already removed): just create the
    // excluded name and the back-compat link.
    fs.mkdirSync(noIndexDir, { recursive: true })
    linkBackCompat(legacyDir, noIndexDir, log)
    return { workspacesDir: noIndexDir, excluded: true, migrated: false, blocked: null }
  }

  if (!legacyStat.isDirectory()) {
    log(`${legacyDir} is not a directory — leaving it alone`)
    return keepLegacy('rename-failed', `${legacyDir} is not a directory`)
  }

  try {
    fs.renameSync(legacyDir, noIndexDir)
  } catch (err) {
    const detail = describeError(err)
    log(`could not rename ${legacyDir} to ${NOINDEX_WORKSPACES_DIRNAME}: ${detail}`)
    return keepLegacy('rename-failed', detail)
  }

  linkBackCompat(legacyDir, noIndexDir, log)
  log(`moved the workspaces dir to ${noIndexDir}; ${legacyDir} is now a back-compat symlink`)
  return { workspacesDir: noIndexDir, excluded: true, migrated: true, blocked: null }
}

/**
 * Recreate `<data>/workspaces` as a relative symlink to `workspaces.noindex`.
 * Only old absolute paths need it (stored project paths, chat history, pty
 * records); everything the app does uses the real path.
 */
function linkBackCompat(legacyDir: string, noIndexDir: string, log: (message: string) => void): void {
  if (lstatOrNull(legacyDir)) return
  try {
    fs.symlinkSync(path.basename(noIndexDir), legacyDir, 'dir')
  } catch (err) {
    // The directory is excluded either way; only old persisted paths suffer.
    log(`could not create the back-compat symlink ${legacyDir}: ${describeError(err)}`)
  }
}
