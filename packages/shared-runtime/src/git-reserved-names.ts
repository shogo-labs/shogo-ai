// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Windows device names as workspace paths (SHO-180 / #1686).
 *
 * `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and `LPT1`–`LPT9` are DOS devices,
 * not filenames: Windows cannot create, check out or index a path whose segment
 * is one of them. A single untracked `nul` in the tree therefore makes
 * `git add -A` exit 128 on every sync cycle, and the workspace silently stops
 * being backed up.
 *
 * The name is what creates it: the `exec` tool runs Git Bash on Windows, so the
 * cmd habit `cmd 2>nul` writes a real file called `nul` into the cwd (see
 * `rewriteNulRedirectsOnWindows` in `@shogo/agent-runtime`, which now guards the
 * source of the problem).
 *
 * These paths cannot be checked out on Windows anyway, so leaving them out of a
 * commit is correct on every platform — which also keeps desktop and cloud on
 * one code path (no `process.platform` branch in the sync).
 */

/** A whole segment, up to its first dot, that Windows reserves. */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** True when any segment of `path` is a reserved Windows device name. */
export function isWindowsReservedPath(path: string): boolean {
  if (!path) return false
  return path.split(/[\\/]+/).some((segment) => {
    const base = segment.split('.')[0]
    return base.length > 0 && RESERVED_SEGMENT.test(base)
  })
}

/**
 * The paths in `paths` that must never be staged. Kept as one call so the sync
 * has a single place to point at when the rule changes.
 */
export function findReservedPaths(paths: string[]): string[] {
  return paths.filter((p) => isWindowsReservedPath(p))
}
