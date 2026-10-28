// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exec cwd markers.
 *
 * `exec` learns the shell's final cwd from a file the command's EXIT trap
 * writes (`trap '/bin/pwd > "<marker>"' EXIT`). The file is a temp file with a
 * lifetime, not workspace state: it must never land in the user's tree.
 *
 * Markers therefore live in `<workspaceDir>/.shogo/exec-cwd/`, which Shogo
 * already excludes from checkpoints, exports and the managed git ignore block
 * (`shogo-state-paths.ts`), so a folder-linked repo never sees them in its
 * root. `sweepExecCwdMarkers` clears anything a crash or a kill left behind.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/** Workspace-relative directory the markers are written to. */
export const EXEC_CWD_DIR = '.shogo/exec-cwd'

/** Every marker name starts with this, wherever it lives. */
export const EXEC_CWD_PREFIX = '.shogo-cwd-'

/**
 * Older markers are litter: a live command's marker is written only as it
 * exits, so nothing that has existed this long can belong to a running shell.
 */
export const EXEC_CWD_MAX_AGE_MS = 10 * 60 * 1000

export function newExecCwdMarker(
  now: number = Date.now(),
  rand: string = Math.random().toString(36).slice(2),
): string {
  return `${EXEC_CWD_PREFIX}${now}-${rand}`
}

/**
 * Host directory the markers go in, created on demand. `null` when it cannot
 * be created — the caller then falls back to the workspace root, because a
 * missing cwd capture is a much worse failure than a stray temp file.
 */
export function execCwdDirFor(workspaceDir: string): string | null {
  const dir = join(workspaceDir, EXEC_CWD_DIR)
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/**
 * Read a marker and unlink it. Returns the cwd the trap wrote, or `null` when
 * the trap never fired (or the file was already consumed). Safe to call twice.
 */
export function consumeExecCwdMarker(file: string): string | null {
  let raw: string | null = null
  try {
    raw = readFileSync(file, 'utf-8').trim() || null
  } catch {
    /* trap may not have fired or the marker is already gone */
  }
  try {
    unlinkSync(file)
  } catch {
    /* already gone */
  }
  return raw
}

/**
 * Delete leftover markers: `.shogo-cwd-*` at the workspace root (written by
 * older builds and by runs that crashed before they could be drained) and
 * stale entries under `.shogo/exec-cwd/`. Fresh markers are left alone so an
 * in-flight command's EXIT trap still finds its own path.
 *
 * Returns the number of files removed.
 */
export function sweepExecCwdMarkers(
  workspaceDir: string,
  maxAgeMs: number = EXEC_CWD_MAX_AGE_MS,
): number {
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  const sweep = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(EXEC_CWD_PREFIX)) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs >= cutoff) continue
        unlinkSync(file)
        removed++
      } catch {
        /* raced with a trap, another sweep, or a directory of that name */
      }
    }
  }
  sweep(workspaceDir)
  sweep(join(workspaceDir, EXEC_CWD_DIR))
  if (removed) console.log(`[exec-cwd] swept ${removed} stale marker(s) from ${workspaceDir}`)
  return removed
}
