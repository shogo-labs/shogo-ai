// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Task logs have to outlive the VM that wrote them (SHO-141, #1634).
 *
 * On a 9p-mounted workspace `onAssign` replaces `<workspace>/.shogo` with a
 * symlink to `POOL_STATE_ROOT/<projectId>/.shogo` — the VM's local overlay
 * disk. SQLite needs that (fcntl locking and truncation do not work over 9p),
 * but it also means every other file in `.shogo/` dies with the VM. That is
 * how the log explaining a killed background task disappeared exactly when it
 * was needed: the notice pointed at `<workspace>/.shogo/tasks/…` and the next
 * assignment started with an empty `tasks/`.
 *
 * The cure has to stay narrow. `sessions.db` is rehydrated from S3, so it is
 * fine on the overlay; task logs are plain append-only files that nothing
 * syncs and that sync nothing else, so they belong on host-backed storage. This
 * module makes `<workspace>/.shogo/tasks` a symlink to
 * `<host-workspaces>/.shogo-state/<projectId>/tasks` — outside the user's repo
 * tree, and the same logical path every caller already uses, so
 * `taskOutputRoot()` and everything above it are untouched.
 *
 * On the host, `<host-workspaces>` is the API's `WORKSPACES_DIR`, so that
 * directory is `<workspacesDir>/.shogo-state/<projectId>` and the API has to
 * sweep it when the project or workspace goes away —
 * `apps/api/src/services/workspace-files.service.ts` (`projectTaskStateDir`)
 * owns that half. The two packages share no code, so this path is written down
 * twice on purpose: change one and you must change the other.
 *
 * Everything here is best-effort by design: a warm-pool VM counts a throwing
 * assign as a boot failure and disables the pool after three, so a failure to
 * install the symlink must degrade to the old local-disk behaviour and warn,
 * never throw.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { join } from 'path'

export interface DurableTaskLogOpts {
  /** The overlay directory that `<workspace>/.shogo` points at on a mounted VM. */
  localShogoDir: string
  /** Host-backed 9p share root (`/host-workspaces`). Absent = no mount to preserve against. */
  hostWorkspacesRoot?: string
  projectId: string
  /**
   * Directories holding a `.shogo/` that was moved aside during this assign
   * (`.shogo.host-bak-*`). Their `tasks/` is carried into the durable root, so
   * logs written before the workspace was mounted are not orphaned.
   */
  adoptFrom?: string[]
  /** Where to report a degraded best-effort path. Defaults to `console.warn`. */
  warn?: (message: string) => void
}

export interface DurableTaskLogResult {
  /** Host-backed tasks dir, or `null` when the workspace is not mounted. */
  durableRoot: string | null
  /** True when `<localShogoDir>/tasks` points at `durableRoot`. */
  linked: boolean
}

/** Task logs for a project, on host-backed storage, outside the repo tree. */
export function durableTaskLogRoot(hostWorkspacesRoot: string, projectId: string): string {
  // The host-side twin of this path is `projectTaskStateDir()` in
  // apps/api/src/services/workspace-files.service.ts — it sweeps it on delete.
  return join(hostWorkspacesRoot, '.shogo-state', projectId, 'tasks')
}

/**
 * Copy one directory's contents into another, merging on name. Files are copied
 * rather than renamed: the source lives on the VM's overlay disk and the
 * destination is a 9p mount, so `rename` fails with EXDEV.
 */
function mergeDirContents(srcDir: string, dstDir: string): void {
  let entries
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const from = join(srcDir, entry.name)
    const to = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      try { mkdirSync(to, { recursive: true }) } catch { continue }
      mergeDirContents(from, to)
      try { rmSync(from, { recursive: true, force: true }) } catch { /* left for the next sweep */ }
      continue
    }
    if (existsSync(to)) continue
    try {
      copyFileSync(from, to)
      rmSync(from, { force: true })
    } catch { /* keep the source if the copy did not land */ }
  }
}

/**
 * Make `<workspace>/.shogo/tasks` survive the VM it was written on.
 *
 * Idempotent: a second assign for the same project on a fresh VM finds the
 * symlink already in place (or installs it) and sees the earlier VM's logs
 * through it, which is the whole point.
 */
export function ensureDurableTaskLogs(opts: DurableTaskLogOpts): DurableTaskLogResult {
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const linkPath = join(opts.localShogoDir, 'tasks')

  if (!opts.hostWorkspacesRoot) {
    // Desktop / isolated mode: `.shogo` is already on host-backed storage.
    return { durableRoot: null, linked: false }
  }

  const durableRoot = durableTaskLogRoot(opts.hostWorkspacesRoot, opts.projectId)

  // Adopt anything a previous writer left in the overlay or in a moved-aside
  // `.shogo` before the symlink hides it.
  const adopt = (dir: string) => {
    try { mergeDirContents(dir, durableRoot) } catch { /* best effort */ }
  }

  try {
    mkdirSync(durableRoot, { recursive: true })
  } catch (err: any) {
    warn(`[onAssign] Could not create durable task-log dir ${durableRoot} (${err?.message ?? err}) — task logs stay on the VM overlay and will not survive a restart.`)
    return { durableRoot: null, linked: false }
  }

  for (const dir of opts.adoptFrom ?? []) adopt(join(dir, 'tasks'))

  let linkStat: ReturnType<typeof lstatSync> | null = null
  try { linkStat = lstatSync(linkPath) } catch { /* nothing there yet */ }

  if (linkStat?.isSymbolicLink()) {
    try {
      if (readlinkSync(linkPath) === durableRoot) return { durableRoot, linked: true }
    } catch { /* dangling — replace it below */ }
    try { rmSync(linkPath, { force: true }) } catch { /* fall through */ }
  } else if (linkStat?.isDirectory()) {
    // A real dir from an earlier VM or a pre-mount run: carry it across first.
    adopt(linkPath)
    try { rmSync(linkPath, { recursive: true, force: true }) } catch { /* fall through */ }
  }

  if (existsSync(linkPath)) {
    warn(`[onAssign] ${linkPath} still exists after the move — task logs stay on the VM overlay.`)
    return { durableRoot, linked: false }
  }

  try {
    symlinkSync(durableRoot, linkPath)
    return { durableRoot, linked: true }
  } catch (err: any) {
    warn(`[onAssign] Could not link ${linkPath} -> ${durableRoot} (${err?.message ?? err}) — task logs stay on the VM overlay and will not survive a restart.`)
    return { durableRoot, linked: false }
  }
}
