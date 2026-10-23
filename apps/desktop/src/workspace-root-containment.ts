// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Managed-workspace containment check for the desktop filesystem fast-path.
 *
 * Lives in its own module (rather than inside `fs-ipc.ts`, which imports
 * Electron and the bundled agent-runtime) so the rule that decides whether a
 * renderer-supplied path is a managed project is unit-testable against real
 * temp directories.
 *
 * Why the old paths matter (SHO-152): on macOS the workspaces dir moved to
 * `data/workspaces.noindex` with `data/workspaces` left as a symlink, so the
 * app now hands out the real path while the DB — and every chat message,
 * pty record and checkpoint row written before the move — still holds
 * `data/workspaces/<id>`. Both sides are `realpath`'d here, which is what keeps
 * a project opened through the legacy path trusted instead of rejected as
 * "not-managed".
 */
import fs from 'node:fs'
import path from 'node:path'

export function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Resolve a user-supplied workspace root to its canonical absolute form, but
 * ONLY if it lives directly under `workspacesDir`. Returns null for anything
 * else (external folder-bound projects, traversal attempts, paths outside the
 * workspaces dir entirely).
 *
 * Resolves symlinks at the workspaces-root level via `realpathSync` so a
 * symlinked data dir — or the `workspaces` → `workspaces.noindex` back-compat
 * link — doesn't get falsely rejected, while still pinning the validation to
 * the canonical path.
 */
export function resolveManagedWorkspaceRoot(rawRoot: string, workspacesDir: string): string | null {
  if (!rawRoot || typeof rawRoot !== 'string') return null
  let resolved: string
  try {
    resolved = realpathOrSelf(path.resolve(rawRoot))
  } catch {
    return null
  }
  const root = realpathOrSelf(workspacesDir)
  if (!resolved.startsWith(root + path.sep)) return null
  // Reject the workspaces root itself + any path more than one level deep
  // (only `<workspacesDir>/<projectId>` is a valid workspace root).
  const rel = resolved.slice(root.length + 1)
  if (rel.length === 0) return null
  if (rel.includes(path.sep)) return null
  if (!fs.existsSync(resolved)) return null
  return resolved
}
