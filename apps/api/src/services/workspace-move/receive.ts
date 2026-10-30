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
import { isIncludedModel } from '../workspace-export/manifest'
import {
  CLOUD_WORKSPACE_ROOT_NOTICE,
  assertTargetStorageConfigured,
  hydrateTargetProject,
  isWorkspaceRootPath,
  moveStagingDir,
  moveUsesCloudStorage,
  stagingManifest,
  storeTargetProject,
} from './cloud'
import { moveDirFor, walkMoveFiles, writeMoveFile } from './files'
import { moveIgnoreRules } from './ignores'
import type { HandoverKind } from './handover'
import { shouldMoveModel } from './records'
import { assertRowsInWorkspace } from './scope'
import type { MoveFileEntry, MoveFileManifest, MoveRow } from './types'
import { WORKSPACE_ROOT_ID, WorkspaceMoveError } from './types'

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
      if (!/Unknown argument|does not exist|no such column/i.test(String(err?.message))) {
        // Name the model and the row: "Foreign key constraint violated" on its
        // own says nothing about which of the sixty models broke, which is how
        // a real move's first failure took an afternoon to place. The driver
        // text and the file path stay in the log — returning them handed the
        // caller SQL, an absolute path and the column names (SEC-18).
        console.error(`[workspace-move] ${model} row ${String(row?.id ?? '?')} could not be written:`, err)
        throw new WorkspaceMoveError(
          `${model} row ${String(row?.id ?? '?')} could not be written.`,
          500,
          'workspace_move_failed',
        )
      }
    }
  }
  return { inserted }
}

/**
 * Where a received project's files go.
 *
 * Resolved through `moveDirFor` so the sentinel and the containment check are
 * the same ones the source side uses — `join(base, projectId)` here was the
 * write half of SEC-18.
 */
export function targetProjectDir(projectId: string, workspaceId: string, base = workspacesDir()): string {
  return moveDirFor({ projectId, workspaceId, base })
}

export function targetWorkspaceRootDir(workspaceId: string, base = workspacesDir()): string {
  return moveDirFor({ projectId: WORKSPACE_ROOT_ID, workspaceId, base })
}

/**
 * What the target already holds for a project. The driver diffs against this, so
 * a resumed move only sends what is missing.
 *
 * On Kubernetes the target's files live in S3, not on the API pod, so the
 * staging directory is first refreshed from the project's prefix — otherwise a
 * resume on a different API pod would believe it holds nothing and resend the
 * whole project, or (worse) believe it holds files the store never received.
 */
export async function targetFileManifest(
  projectId: string,
  workspaceId: string,
  base = workspacesDir(),
): Promise<MoveFileManifest> {
  if (moveUsesCloudStorage() && !isWorkspaceRootPath(projectId)) {
    await hydrateTargetProject(projectId, moveStagingDir(projectId, workspaceId, base))
    return stagingManifest(projectId, workspaceId, base)
  }
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
  // Refuse before writing rather than after: a move that cannot store its files
  // must not report `done` (SHO-252 AC 2). The workspace root has no cloud store
  // yet, so it is not gated here — see `flushTargetProject`.
  if (moveUsesCloudStorage() && !isWorkspaceRootPath(projectId)) {
    assertTargetStorageConfigured()
  }
  writeMoveFile(moveDirFor({ projectId, workspaceId, base }), relPath, bytes)
}

/**
 * Hand a project's received files to the store the runtime reads.
 *
 * Called once per project, after its files have landed. A no-op off Kubernetes
 * (the target's own directory *is* the store there) and for the workspace root,
 * which has no cloud store yet — that gap is reported, never silent.
 */
export async function flushTargetProject(
  projectId: string,
  workspaceId: string,
  base = workspacesDir(),
): Promise<{ notices: string[] }> {
  if (!moveUsesCloudStorage()) return { notices: [] }
  if (isWorkspaceRootPath(projectId)) return { notices: [CLOUD_WORKSPACE_ROOT_NOTICE] }
  await storeTargetProject(projectId, moveStagingDir(projectId, workspaceId, base))
  return { notices: [] }
}

/**
 * Turn a moved schedule or trigger on/off at the target. `ids` are derived ids,
 * so this is safe to replay.
 *
 * Scoped to the workspace: `updateMany({ where: { id: { in: ids } } })` let a
 * caller flip a schedule or trigger belonging to any workspace in the instance
 * by guessing an id (SEC-18).
 */
export async function setEnabledAtTarget(
  db: any,
  input: { workspaceId: string; kind: HandoverKind; ids: string[]; enabled: boolean },
): Promise<void> {
  if (!input.ids.length) return
  const model = input.kind === 'schedule' ? 'agentSchedule' : 'eventSubscription'
  await db[model].updateMany({
    where: { id: { in: input.ids }, workspaceId: input.workspaceId },
    data: { enabled: input.enabled },
  })
}

// ─── What may arrive over the wire (SEC-18) ───────────────────────────

/**
 * Models that are never workspace content, so a move must never write them from
 * the other side of a link.
 *
 * `writeRecordChunk` will happily write any model name it is handed — that is
 * what made `/receive/records` a way to write `Member{userId: me, workspaceId:
 * victim, role: 'owner'}` into someone else's tenant. This list is the explicit
 * deny, and `isIncludedModel` below is the general one: only a model the
 * workspace export manifest carries is workspace content at all.
 */
const NEVER_FROM_THE_WIRE: ReadonlySet<string> = new Set([
  'Account',
  'ApiKey',
  'BillingAccount',
  'Instance',
  'InstanceSubscription',
  'Invitation',
  'InviteLink',
  'LicenseKey',
  'Member',
  'ProjectAuthConfig',
  'ProjectAuthSignIn',
  'Session',
  'Subscription',
  'UsageEvent',
  'UsageWallet',
  'Verification',
  'WorkspaceGrant',
])

/**
 * A model name is a Prisma model name: the wire never names a table.
 *
 * Whether a row is inside the workspace is checked by
 * `assertRowsInWorkspace` in `scope.ts`, which walks each row's parent chain
 * through the export manifest.
 */
const MODEL_NAME = /^[A-Z][A-Za-z0-9]*$/

function denied(model: string): WorkspaceMoveError {
  return new WorkspaceMoveError(
    `"${model.slice(0, 60)}" is not workspace content and cannot be written by a move.`,
    400,
    'workspace_move_model_denied',
  )
}

/** Refuse a model a move may not write, before any row is touched. */
export function assertReceivableModel(model: string): void {
  if (!MODEL_NAME.test(model)) {
    throw new WorkspaceMoveError(`Unknown model "${model.slice(0, 60)}"`, 400, 'workspace_move_unknown_model')
  }
  if (NEVER_FROM_THE_WIRE.has(model) || !shouldMoveModel(model) || !isIncludedModel(model)) {
    throw denied(model)
  }
}

/**
 * Write one received chunk, confined to the authorised workspace.
 *
 * Three rules, and a chunk is refused rather than repaired when it breaks one:
 *   1. the model must be workspace content (`assertReceivableModel`);
 *   2. a row that names a `workspaceId` must name **this** workspace — a row
 *      that names another one is a request to write into another tenant, and
 *      rewriting it silently would hide that;
 *   3. every row must be reachable from this workspace by walking its parent
 *      chain (`ChatMessage` → `ChatSession` → workspace, `MessageFeedback` →
 *      `ChatMessage` → …, a project-scoped model → `Project` → workspace). The
 *      chain is read from the export manifest, not listed here: a fixed list of
 *      foreign keys was how a `ChatMessage` naming a victim's `sessionId` got
 *      written into their transcript (SEC-18).
 */
export async function writeMoveRecordChunk(
  db: any,
  input: { workspaceId: string; model: string; rows: MoveRow[] },
): Promise<{ inserted: number }> {
  if (!input.workspaceId) {
    throw new WorkspaceMoveError('A workspace id is required.', 400, 'workspace_required')
  }
  const rows = input.rows.filter((row) => row && typeof row === 'object')
  // `User` travels with a move only because `Member` has a foreign key to it
  // (`attachMemberUsers` sends the four columns a member row needs). It is
  // account data, not workspace content: the receiving instance is the only
  // thing allowed to create or change an account, so a `User` row here may only
  // confirm one it already knows. Anything else — which is how you would squat
  // someone's email and block their sign-up — is refused.
  if (input.model === 'User') return assertKnownUsers(db, rows)
  assertReceivableModel(input.model)
  for (const row of rows) {
    if (row.workspaceId && String(row.workspaceId) !== input.workspaceId) {
      throw new WorkspaceMoveError(
        'A row in that chunk belongs to another workspace.',
        400,
        'workspace_move_foreign_row',
      )
    }
  }
  await assertRowsInWorkspace(db, input.workspaceId, input.model, rows)
  return writeRecordChunk(db, input.model, rows)
}

async function assertKnownUsers(db: any, rows: MoveRow[]): Promise<{ inserted: number }> {
  const ids = [...new Set(rows.map((row) => String(row.id ?? '')).filter(Boolean))]
  if (!ids.length) return { inserted: 0 }
  const known: Array<{ id: string }> = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true } })
  const found = new Set(known.map((row) => row.id))
  const unknown = ids.find((id) => !found.has(id))
  if (unknown) {
    throw new WorkspaceMoveError(
      `A user in that chunk (${unknown.slice(0, 60)}) is not an account on this instance.`,
      400,
      'workspace_move_unknown_user',
    )
  }
  return { inserted: 0 }
}

/** A git branch a clone may be asked for: a ref, never an option. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * Refuse a clone target that is not a plain https remote and branch.
 *
 * `git clone --branch <b> <remote> <dir>` passed both straight through, so a
 * caller chose the scheme (`file:`, `ssh:`, `ext::`) and could lead the argument
 * list with `--upload-pack=…`. Only `https:` is a remote a move can mean, and
 * `--` in front of the positional arguments stops anything being read as an
 * option (SEC-18).
 */
export function assertCloneSource(remote: string, branch: string): void {
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    throw new WorkspaceMoveError('That project remote is not a URL.', 400, 'workspace_move_bad_remote')
  }
  if (url.protocol !== 'https:') {
    throw new WorkspaceMoveError(
      `A move can only clone an https remote, not "${url.protocol}".`,
      400,
      'workspace_move_bad_remote',
    )
  }
  if (remote.startsWith('-') || !SAFE_BRANCH.test(branch) || branch.includes('..')) {
    throw new WorkspaceMoveError('That branch name is not allowed.', 400, 'workspace_move_bad_branch')
  }
}

/**
 * A folder-linked project with a remote is re-linked, not copied: the target
 * clones the same branch and points `ProjectFolder` at the clone (decision D3).
 */
export async function relinkTargetProject(
  db: any,
  input: { projectId: string; name: string; remote: string; branch: string; workspaceId: string },
): Promise<{ path: string }> {
  assertCloneSource(input.remote, input.branch)
  const dir = targetProjectDir(input.projectId, input.workspaceId)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const { spawnSync } = await import('@shogo/shared-runtime/child-process')
  const clone = spawnSync('git', ['clone', '--branch', input.branch, '--', input.remote, dir], {
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
