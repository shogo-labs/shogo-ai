// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file-tree walker — shared between the HTTP agent-runtime server
 * (`server.ts`) and the Electron desktop IPC fast-path (`apps/desktop/src/
 * fs-ipc.ts`). Keeping a single source of truth here means the IDE Monaco
 * file tree behaves the same whether it's hitting the cloud agent-runtime
 * over HTTP or going through the local Electron preload bridge.
 *
 * No agent-runtime imports — this module uses only `node:fs` + `node:path`
 * so it can be bundled into the Electron main process (which doesn't carry
 * the agent-runtime's dep graph) without dragging in Hono, the index
 * engine, etc.
 *
 * Policy (VS Code defaults — see vs_code_file_tree plan §"Refined behavior"):
 *
 *   HIDDEN_DIRS  — Never returned. VCS metadata. VS Code's `files.exclude`
 *                  defaults: .git / .svn / .hg / CVS.
 *
 *   LAZY_DIRS    — Returned as a directory entry with `lazy: true` and no
 *                  `children`. Callers fetch children on demand. Mirrors the
 *                  watcher's `IGNORED_PATH_PREFIXES` in
 *                  `canvas-file-watcher.ts` so the invariant "shown in the
 *                  tree, ignored by the watcher" holds by construction.
 *
 *   HIDDEN_FILES — Never returned. OS junk only.
 *
 * Product-UX filtering (hiding `package.json`, `AGENTS.md`, the four pinned
 * `*.md` shortcuts, etc.) does NOT happen here — that lives client-side in
 * `apps/mobile/components/project/panels/files-browser-filter.ts`. The IDE
 * Monaco file tree needs to see configs + dotfiles; the agent-files panel
 * doesn't. Do not re-introduce product-UX excludes server-side: they'll
 * silently break the IDE.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const WORKSPACE_TREE_HIDDEN_DIRS: ReadonlySet<string> = new Set([
  '.git', '.svn', '.hg', 'CVS',
])

export const WORKSPACE_TREE_LAZY_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist', 'build',
  'dist.canvas.staging', 'dist.staging', 'dist.prev',
  '.next', '.cache', '.turbo', '.parcel-cache',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv',
])

export const WORKSPACE_TREE_HIDDEN_FILES: ReadonlySet<string> = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '.virtfs_metadata',
])

/**
 * Node shape returned by `walkFilesTree`. Matches the `FileNode` interface
 * exposed by `@shogo-ai/sdk/agent` (kept structural so we don't need a
 * package dep from this low-level module — the SDK reshapes if needed).
 */
export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  /** Last-modified time as a Unix epoch in milliseconds. */
  modified: number
  /** File size in bytes; only set for files. */
  size?: number
  /** Walked children; undefined for files and for `lazy: true` directories. */
  children?: WorkspaceTreeNode[]
  /**
   * True on directories whose children intentionally weren't walked
   * (members of `WORKSPACE_TREE_LAZY_DIRS`). Callers should fetch children
   * on demand by re-invoking `walkFilesTree` rooted at the directory's
   * absolute path.
   */
  lazy?: boolean
}

/**
 * Walk a directory recursively, applying the three-bucket exclusion policy.
 *
 * `dir` is the absolute starting directory (must exist and be inside
 * `rootDir`). `rootDir` is the absolute workspace root — used only to make
 * the emitted `path` field relative + POSIX-style.
 *
 * Returns the children of `dir`, NOT a node for `dir` itself. Empty array
 * if `dir` doesn't exist.
 */
export function walkFilesTree(
  dir: string,
  rootDir: string,
  hiddenDirs: ReadonlySet<string> = WORKSPACE_TREE_HIDDEN_DIRS,
  lazyDirs: ReadonlySet<string> = WORKSPACE_TREE_LAZY_DIRS,
  hiddenFiles: ReadonlySet<string> = WORKSPACE_TREE_HIDDEN_FILES,
): WorkspaceTreeNode[] {
  if (!existsSync(dir)) return []
  const results: WorkspaceTreeNode[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name)
    // Always emit POSIX-style separators so Windows runtimes don't surface
    // `tools\foo\bar.ts` (which the IDE would then URL-encode as `%5C`).
    const relPath = absPath.slice(rootDir.length + 1).replace(/\\/g, '/')
    let stat
    try {
      stat = statSync(absPath)
    } catch {
      // Broken symlink or race with a concurrent delete — skip rather than
      // 500-ing the whole tree.
      continue
    }
    if (entry.isDirectory()) {
      if (hiddenDirs.has(entry.name)) continue
      if (lazyDirs.has(entry.name)) {
        // Visible in the tree but children not walked. Callers fetch
        // children on demand.
        results.push({
          name: entry.name,
          path: relPath,
          type: 'directory',
          modified: stat.mtimeMs,
          lazy: true,
        })
        continue
      }
      results.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        modified: stat.mtimeMs,
        children: walkFilesTree(absPath, rootDir, hiddenDirs, lazyDirs, hiddenFiles),
      })
    } else {
      if (hiddenFiles.has(entry.name)) continue
      results.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
      })
    }
  }
  return results
}
