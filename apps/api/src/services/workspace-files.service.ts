// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What files belong to a workspace, and how to remove them.
 *
 * The layout (shared with the workspace exporter and the runtime manager):
 *
 *   <WORKSPACES_DIR>/<projectId>              one app-owned tree per managed project
 *   <WORKSPACES_DIR>/.workspace-roots/<id>    this workspace's merged runtime root
 *   <WORKSPACES_DIR>/.workspace-roots/proj-<anchorProjectId>
 *                                             the same thing, for a project-anchored runtime
 *   <WORKSPACES_DIR>/.shogo-state/<projectId>/tasks
 *                                             a project's durable task logs (SHO-151), written
 *                                             by the runtime from inside the VM — app-owned for
 *                                             every project, folder-linked ones included
 *
 * A *folder-linked* project (`workingMode: 'external'`) has no app-owned tree:
 * its content is the user's own folder (`ProjectFolder.path`), which is only
 * ever linked into a merged root. Those paths are reported but NEVER removed —
 * see {@link removeAppOwnedTree}, which unlinks symlinks instead of following
 * them so a link into a user's repo can never be walked through.
 *
 * One definition for delete, the deletion preview and (later) the exporter, so
 * the three cannot drift apart.
 */

import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from 'fs'
import type { Dirent } from 'fs'
import { join, relative, resolve, sep } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')

/** Stop measuring a project directory after this long and report it as unknown. */
const SIZE_WALK_BUDGET_MS = 2_000

export function resolveWorkspacesDir(explicit?: string): string {
  return resolve(explicit || process.env.WORKSPACES_DIR || join(PROJECT_ROOT, 'workspaces'))
}

/**
 * Where a project's durable task logs live on host-backed storage.
 *
 * In a 9p-mounted VM the agent runtime keeps task logs outside the project tree
 * so they survive the VM that wrote them, at
 * `<host-workspaces>/.shogo-state/<projectId>/tasks`
 * (`packages/agent-runtime/src/task-log-durability.ts`,
 * `durableTaskLogRoot`). `<host-workspaces>` is this same `workspacesDir` shared
 * into the guest, so on the host the directory to sweep is this one — the two
 * packages cannot share code, so keep the pair in step by hand.
 *
 * `.shogo-state` itself is deliberately left in place when it empties: it is
 * app-owned scaffolding a concurrent assign writes into.
 */
export function projectTaskStateDir(workspacesDir: string, projectId: string): string {
  return join(workspacesDir, '.shogo-state', projectId)
}

export interface InventoryProject {
  id: string
  name: string
  /** Directory the app owns for this project; null for a folder-linked project. */
  path: string | null
  sizeBytes: number | null
  /** True when the project's content lives in the user's own folder. */
  folderLinked: boolean
  /** The user's folder for a folder-linked project. Never deleted. */
  folderPath: string | null
}

export interface WorkspaceFileInventory {
  workspaceId: string
  workspaceName: string
  projects: InventoryProject[]
  /** App-owned directories that a delete removes. */
  removedDirs: string[]
  channelCount: number
  boardCount: number
  chatCount: number
  totalBytes: number | null
}

/** Byte size of a directory tree, or null when the walk exceeds its budget. */
export function directorySize(path: string, deadline = Date.now() + SIZE_WALK_BUDGET_MS): number | null {
  let total = 0
  const stack = [path]
  while (stack.length) {
    if (Date.now() > deadline) return null
    const current = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      // Never descend through a symlink: it may point at the user's repo.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      try {
        total += statSync(child).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/** True when `path` is inside `root` (and is not `root` itself). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return !!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && !rel.startsWith(sep)
}

/**
 * Remove an app-owned tree without ever following a symlink out of it.
 *
 * The root itself may be a symlink (an older bind wrote one); in that case the
 * link is unlinked and its target is left untouched. Inside the tree every
 * symlink is unlinked, never descended into.
 */
export function removeAppOwnedTree(path: string, workspacesDir: string): void {
  if (!isInside(workspacesDir, path)) {
    throw new Error(`refusing to remove ${path}: outside ${workspacesDir}`)
  }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      unlinkSync(child)
      continue
    }
    if (entry.isDirectory()) {
      removeAppOwnedTree(child, workspacesDir)
      continue
    }
    rmSync(child, { force: true })
  }
  rmdirSync(path)
}

/**
 * Everything a workspace owns on disk and in the database, sized for the
 * "here is what disappears" preview. Read-only: it mutates nothing.
 */
export async function workspaceFileInventory(
  workspaceId: string,
  opts: { workspacesDir?: string; prisma?: any } = {},
): Promise<WorkspaceFileInventory | null> {
  const prisma = opts.prisma ?? (await import('../lib/prisma')).prisma
  const db = prisma as any
  const workspacesDir = resolveWorkspacesDir(opts.workspacesDir)

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true },
  })
  if (!workspace) return null

  const projects = await db.project.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      workingMode: true,
      projectFolders: { select: { path: true, isPrimary: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const deadline = Date.now() + SIZE_WALK_BUDGET_MS
  const inventoryProjects: InventoryProject[] = []
  const removedDirs: string[] = []
  let totalBytes: number | null = 0

  for (const project of projects as Array<{
    id: string
    name: string
    workingMode?: string | null
    projectFolders?: Array<{ path: string; isPrimary: boolean }>
  }>) {
    const folderLinked = project.workingMode === 'external'
    const primary = project.projectFolders?.find((f) => f.isPrimary) ?? project.projectFolders?.[0]
    const projectDir = join(workspacesDir, project.id)
    const path = folderLinked ? null : projectDir

    // Task logs are app-owned whatever the working mode: they live outside the
    // project tree and outside the user's folder, and nothing else can ever
    // read them once the project is gone.
    const stateDir = projectTaskStateDir(workspacesDir, project.id)
    if (existsSync(stateDir)) {
      removedDirs.push(stateDir)
      const stateSize = directorySize(stateDir, deadline)
      if (stateSize === null || totalBytes === null) totalBytes = null
      else totalBytes += stateSize
    }

    if (path && existsSync(path)) {
      removedDirs.push(path)
      const size = directorySize(path, deadline)
      if (size === null || totalBytes === null) totalBytes = null
      else totalBytes += size
      inventoryProjects.push({
        id: project.id,
        name: project.name,
        path,
        sizeBytes: size,
        folderLinked: false,
        folderPath: null,
      })
      continue
    }

    inventoryProjects.push({
      id: project.id,
      name: project.name,
      path: null,
      sizeBytes: null,
      folderLinked,
      folderPath: primary?.path ?? null,
    })
  }

  // Both merged-root names are derived directories: a workspace-session
  // runtime roots at the workspace id, a project-anchored one at `proj-<anchor>`.
  const rootsDir = join(workspacesDir, '.workspace-roots')
  for (const rootName of [workspaceId, ...projects.map((p: any) => `proj-${p.id}`)]) {
    const dir = join(rootsDir, rootName)
    if (existsSync(dir)) removedDirs.push(dir)
  }

  const [channelCount, boardCount, chatCount] = await Promise.all([
    db.conversation.count({ where: { workspaceId } }).catch(() => 0),
    db.board.count({ where: { workspaceId } }).catch(() => 0),
    db.chatSession.count({ where: { workspaceId } }).catch(() => 0),
  ])

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projects: inventoryProjects,
    removedDirs,
    channelCount,
    boardCount,
    chatCount,
    totalBytes,
  }
}

export interface WorkspaceFileRemovalReport {
  removedDirs: string[]
  warnings: string[]
}

/**
 * Remove the files an inventory lists. Best-effort: a directory that can't be
 * removed is reported as a warning, never thrown, because by the time this
 * runs the workspace is already gone from the database.
 */
export function removeWorkspaceFiles(
  inventory: WorkspaceFileInventory,
  opts: { workspacesDir?: string } = {},
): WorkspaceFileRemovalReport {
  const workspacesDir = resolveWorkspacesDir(opts.workspacesDir)
  const report: WorkspaceFileRemovalReport = { removedDirs: [], warnings: [] }

  for (const dir of inventory.removedDirs) {
    try {
      removeAppOwnedTree(dir, workspacesDir)
      report.removedDirs.push(dir)
    } catch (err: any) {
      report.warnings.push(`${dir}: ${err?.message ?? err}`)
    }
  }

  return report
}
