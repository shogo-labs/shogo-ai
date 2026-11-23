// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { readdirSync } from 'fs'
import { join, relative } from 'path'

// Directories that never hold source we want to scan: dependencies, VCS
// metadata, build output, and the scratch trees the dev agents work in.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.tmp',
  'dist',
  'build',
  'coverage',
  '.expo',
  '.next',
  '.turbo',
  'Pods',
  'generated',
])

export interface WalkSourceFilesOptions {
  /** File suffixes to keep, e.g. ['.test.ts', '.test.tsx']. */
  extensions: readonly string[]
  /** Additional directory names to skip on top of the defaults. */
  skipDirs?: readonly string[]
}

/**
 * Repo-relative paths of every file under `root` whose name ends with one of
 * `extensions`, sorted so two runs on the same tree produce the same list.
 * Symlinks are never followed: a folder-linked project must not pull its real
 * checkout into a scan.
 */
export function walkSourceFiles(root: string, options: WalkSourceFilesOptions): string[] {
  const skip = new Set([...SKIP_DIRS, ...(options.skipDirs ?? [])])
  const found: string[] = []

  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        visit(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!options.extensions.some((ext) => entry.name.endsWith(ext))) continue
      found.push(relative(root, join(dir, entry.name)).split('\\').join('/'))
    }
  }

  visit(root)
  return found.sort()
}
