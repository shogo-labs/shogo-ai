// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where the child-ledger reaper has to look (SHO-277).
 *
 * Every runtime records the detached groups it started in
 * `<its workspace dir>/.shogo/run/children.json` (see
 * `@shogo-ai/sdk/child-ledger`). Two kinds of runtime dir exist under the
 * workspaces root:
 *
 *   - `workspaces/<projectId>` — a plain project runtime.
 *   - `workspaces/.workspace-roots/<rootName>` — a merged-root runtime, and
 *     the ONLY kind the team agents ever get. `rootName` is the workspace id
 *     for a workspace runtime or `proj-<anchorProjectId>` for a
 *     project-anchored one.
 *
 * The boot sweep used to skip every dot-directory, so the second kind — all of
 * the agent runtimes — was never reaped at all. That is how a desktop left
 * open for days accumulated 3.6 GB of orphaned `vite build --watch`, Metro and
 * `relay-pod` processes.
 *
 * Other dot-directories (`.warm`, `.cache`, …) hold no ledgers, so they stay
 * out of the walk.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { reapChildLedger, type ReapChildLedgerOptions, type ReapChildLedgerResult } from '@shogo-ai/sdk/child-ledger'

/** The merged-root runtimes' parent, dot-prefixed so it is never a project id. */
export const WORKSPACE_ROOTS_DIR = '.workspace-roots'

/**
 * Real subdirectories of `dir`. `isDirectory()` is false for a symlink, which
 * is what we want: a `.workspace-roots` entry links at a member project, and
 * reaping through it would replay that project's ledger twice.
 */
function realSubdirectories(dir: string): string[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as any
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
}

/**
 * Every directory under `workspacesDir` that can own a child ledger, in a
 * stable order. Missing directories are simply absent — a runtime that never
 * started has nothing to reap.
 */
export function childLedgerDirs(workspacesDir: string): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (dir: string) => {
    if (seen.has(dir)) return
    seen.add(dir)
    dirs.push(dir)
  }

  for (const dir of realSubdirectories(workspacesDir)) {
    const name = dir.slice(workspacesDir.length + 1)
    if (name.startsWith('.')) continue
    add(dir)
  }
  for (const dir of realSubdirectories(join(workspacesDir, WORKSPACE_ROOTS_DIR))) add(dir)
  return dirs
}

export interface SweptLedger {
  /** Directory whose ledger was reaped (the runtime dir, not the ledger file). */
  dir: string
  result: ReapChildLedgerResult
}

/**
 * Reap every ledger under `workspacesDir`. Each entry is only signalled while
 * its command line still matches what was recorded, so a reused pid is dropped
 * rather than killed.
 */
export function reapChildLedgersUnder(
  workspacesDir: string,
  opts: ReapChildLedgerOptions = {},
): SweptLedger[] {
  const swept: SweptLedger[] = []
  for (const dir of childLedgerDirs(workspacesDir)) {
    try {
      const result = reapChildLedger(dir, opts)
      if (result.reaped.length > 0 || result.dropped.length > 0) swept.push({ dir, result })
    } catch {
      // One unreadable ledger must not stop the sweep for the rest.
    }
  }
  return swept
}
