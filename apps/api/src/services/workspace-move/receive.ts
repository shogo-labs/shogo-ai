// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The receiving side of a move: everything the target does.
 *
 * These functions are called directly when the target is local (the desktop, for
 * a cloud -> desktop move) and from the `/api/workspace-moves/receive/*` routes
 * when the target is remote (the cloud, for a desktop -> cloud move). One
 * implementation, two callers — the same code path on both surfaces.
 *
 * Idempotency is the whole point: every write here can be repeated after a
 * dropped connection and must land the same state.
 */

import { join } from 'node:path'
import { workspacesDir } from '../workspace-export/files'
import { moveDirFor, walkMoveFiles, writeMoveFile } from './files'
import { moveIgnoreRules } from './ignores'
import type { HandoverKind } from './handover'
import type { MoveFileEntry, MoveFileManifest, MoveRow } from './types'
import { WorkspaceMoveError } from './types'

export interface InitTargetInput {
  name: string
  sourceWorkspaceId: string
  /** The member who becomes owner of the new workspace. */
  ownerUserId: string
  /** Copied from the source so the copy has the same limits. */
  instanceSize?: string | null
}

export interface InitTargetResult {
  workspaceId: string
  name: string
}

/**
 * Create the workspace a move lands in. Always a new workspace (decision D2):
 * merging into an existing one needs per-model conflict rules and is explicitly
 * out of scope.
 */
export async function initTargetWorkspace(db: any, input: InitTargetInput): Promise<InitTargetResult> {
  const name = (input.name || 'Moved workspace').slice(0, 120)
  const workspace = await db.workspace.create({
    data: {
      name,
      slug: `move-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'team',
      ...(input.instanceSize ? { instanceSize: input.instanceSize } : {}),
    },
  })
  await db.member.create({
    data: { userId: input.ownerUserId, role: 'owner', workspaceId: workspace.id, isBillingAdmin: true },
  })
  await db.workspaceAgentProfile
    .create({ data: { workspaceId: workspace.id, name: 'Shogo', tagline: 'Your personal AI companion' } })
    .catch(() => undefined)
  return { workspaceId: workspace.id, name: workspace.name }
}

function clientFor(db: any, model: string): any {
  return db[model.charAt(0).toLowerCase() + model.slice(1)]
}

/**
 * Models whose target row already exists before the records phase runs, keyed by
 * the constraint that makes a second insert fail.
 *
 * `initTargetWorkspace` writes both of these up front: the owner's `Member` row
 * and a placeholder `WorkspaceAgentProfile`. Inserting the moved copy of either
 * collides on `members_workspace_scope_key` / the profile's `workspaceId @unique`
 * — silently on Postgres, where `skipDuplicates` swallows it, and as a P2002 on
 * SQLite. Merging on the natural key makes both drivers behave the same and
 * states which copy wins.
 */
const MERGED_ON_NATURAL_KEY: Record<
  string,
  { where: (row: MoveRow) => any; update: (row: MoveRow) => any }
> = {
  // The target's own membership is authoritative: a move must not demote the
  // owner who ran it, and the source row carries no billing-role knowledge the
  // target lacks.
  Member: {
    where: (row) =>
      row.workspaceId ? { userId_workspaceId: { userId: row.userId, workspaceId: row.workspaceId } } : null,
    update: () => ({}),
  },
  // The placeholder exists only so the workspace is usable mid-move; the moved
  // profile is the real one, so it wins on every column but its identity.
  WorkspaceAgentProfile: {
    where: (row) => (row.workspaceId ? { workspaceId: row.workspaceId } : null),
    update: ({ id: _id, workspaceId: _ws, createdAt: _createdAt, ...rest }) => rest,
  },
}

/**
 * Whether this model's rows are merged onto a row the target already has, rather
 * than inserted. Exported so the guard test can prove every model
 * `initTargetWorkspace` writes is accounted for.
 */
export function mergesOnNaturalKey(model: string): boolean {
  return model in MERGED_ON_NATURAL_KEY
}

/**
 * Insert one chunk. `createMany` first (fast, and `skipDuplicates` makes a
 * replayed chunk a no-op on Postgres); if the driver refuses — SQLite does not
 * support `skipDuplicates` — fall back to per-row upserts, which is what a
 * resumed move pays for only on its last chunk.
 */
export async function writeRecordChunk(db: any, model: string, rows: MoveRow[]): Promise<{ inserted: number }> {
  if (!rows.length) return { inserted: 0 }
  const client = clientFor(db, model)
  if (!client) throw new WorkspaceMoveError(`Unknown model "${model}"`, 400, 'workspace_move_unknown_model')
  const merge = MERGED_ON_NATURAL_KEY[model]
  if (merge) {
    let inserted = 0
    for (const row of rows) {
      const where = merge.where(row)
      if (where) await client.upsert({ where, create: row, update: merge.update(row) })
      else await client.upsert({ where: { id: row.id }, create: row, update: {} })
      inserted++
    }
    return { inserted }
  }
  try {
    if (client.createMany) {
      const res = await client.createMany({ data: rows, skipDuplicates: true })
      return { inserted: res?.count ?? rows.length }
    }
  } catch {
    // Fall through to per-row.
  }
  let inserted = 0
  for (const row of rows) {
    try {
      await client.upsert({ where: { id: row.id }, create: row, update: {} })
      inserted++
    } catch (err: any) {
      // A column the target schema does not have (an older desktop) must not
      // abort the move: count it and keep going.
      if (!/Unknown argument|does not exist|no such column/i.test(String(err?.message))) throw err
    }
  }
  return { inserted }
}

/** Where a received project's files go. */
export function targetProjectDir(projectId: string, base = workspacesDir()): string {
  return join(base, projectId)
}

export function targetWorkspaceRootDir(workspaceId: string, base = workspacesDir()): string {
  return join(base, '.workspace-roots', workspaceId)
}

/**
 * What the target already holds for a project. The driver diffs against this, so
 * a resumed move only sends what is missing.
 */
export async function targetFileManifest(
  projectId: string,
  workspaceId: string,
  base = workspacesDir(),
): Promise<MoveFileManifest> {
  const dir = moveDirFor({ projectId, workspaceId, base })
  const walk = await walkMoveFiles(dir, { rules: moveIgnoreRules(dir), hash: true })
  const entries: MoveFileEntry[] = walk.entries
  return { projectId, entries, ignored: walk.ignored }
}

export async function receiveFile(
  projectId: string,
  workspaceId: string,
  relPath: string,
  bytes: Uint8Array,
  base = workspacesDir(),
): Promise<void> {
  writeMoveFile(moveDirFor({ projectId, workspaceId, base }), relPath, bytes)
}

/**
 * Turn a moved schedule or trigger on/off at the target. `ids` are derived ids,
 * so this is safe to replay.
 */
export async function setEnabledAtTarget(
  db: any,
  kind: HandoverKind,
  ids: string[],
  enabled: boolean,
): Promise<void> {
  if (!ids.length) return
  const model = kind === 'schedule' ? 'agentSchedule' : 'eventSubscription'
  await db[model].updateMany({ where: { id: { in: ids } }, data: { enabled } })
}

/**
 * A folder-linked project with a remote is re-linked, not copied: the target
 * clones the same branch and points `ProjectFolder` at the clone (decision D3).
 */
export async function relinkTargetProject(
  db: any,
  input: { projectId: string; name: string; remote: string; branch: string; workspaceId: string },
): Promise<{ path: string }> {
  const dir = targetProjectDir(input.projectId)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const { spawnSync } = await import('@shogo/shared-runtime/child-process')
  const clone = spawnSync('git', ['clone', '--branch', input.branch, input.remote, dir], {
    encoding: 'utf8',
    timeout: 600_000,
  })
  if (clone.status !== 0) {
    throw new WorkspaceMoveError(
      `Could not clone ${input.remote} (${input.branch}) at the target: ${String(clone.stderr ?? '').trim().slice(0, 300)}`,
      502,
      'workspace_move_clone_failed',
    )
  }
  await db.projectFolder.create({ data: { projectId: input.projectId, path: dir, isPrimary: true } })
  return { path: dir }
}
