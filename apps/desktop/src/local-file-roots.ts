// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Containment rule for "Show in Finder" / "Open" on a local desktop file.
 *
 * The renderer asks main to reveal or open a path that came from a `file://`
 * share_file link. That path is already allowed by the API's
 * `/api/local-files` route, but main re-checks it here rather than trusting
 * the renderer: only a regular file inside the workspaces dir or a
 * folder-linked project root may reach `shell`.
 *
 * Pure node:fs + node:path, so it is unit-testable without Electron.
 */
import fs from 'node:fs'
import path from 'node:path'
import { realpathOrSelf } from './workspace-root-containment'

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Real path of `filePath` when it is a regular file inside one of `roots`,
 * or null otherwise. Both sides are realpath'd, so a symlink that escapes a
 * root is refused (the resolved target is what gets compared).
 */
export function resolveAllowedLocalFile(
  filePath: string,
  roots: readonly string[],
): string | null {
  if (!filePath || typeof filePath !== 'string') return null
  let real: string
  let stats: fs.Stats
  try {
    real = fs.realpathSync(path.resolve(filePath))
    stats = fs.statSync(real)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  for (const root of roots) {
    if (!root) continue
    if (isWithinRoot(realpathOrSelf(path.resolve(root)), real)) return real
  }
  return null
}
