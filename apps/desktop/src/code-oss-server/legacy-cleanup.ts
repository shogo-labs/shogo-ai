// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Leftovers of the old first-use setup, which cloned microsoft/vscode and ran
 * npm install on the user's machine: half-cloned checkouts (often broken by
 * Windows' MAX_PATH), no-space junctions in the temp dir, and per-profile
 * copies of upstream extensions. Removal is best effort.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface LegacyCleanupDirs {
  tempDir: string
  homeDir: string
  /** The desktop data dir (`<userData>/data`). */
  dataDir: string
}

export function legacyCodeOssPaths({ tempDir, homeDir, dataDir }: LegacyCleanupDirs): string[] {
  const paths = [
    path.join(tempDir, 'shogo-codeoss-checkouts'),
    path.join(homeDir, '.shogo', 'code-oss'),
    path.join(dataDir, 'shogo-ide', 'upstream'),
    path.join(dataDir, 'shogo-ide', 'hardening', 'runtime-shogo-ide'),
  ]
  try {
    for (const name of fs.readdirSync(tempDir)) {
      if (/^shogo-codeoss-[0-9a-f]+$/.test(name)) paths.push(path.join(tempDir, name))
    }
  } catch {
    // temp dir unreadable
  }
  return paths
}

/** Removes what exists; returns the paths removed. Links are removed, never followed. */
export function cleanupLegacyCodeOss(dirs: LegacyCleanupDirs): string[] {
  const removed: string[] = []
  for (const target of legacyCodeOssPaths(dirs)) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      continue
    }
    try {
      if (stat.isSymbolicLink()) fs.unlinkSync(target)
      else fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 })
      removed.push(target)
    } catch {
      // In use or locked; the next app version tries again.
    }
  }
  return removed
}
