// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The reading side of a move: everything the source does.
 *
 * Same shape as `receive.ts` — called directly when the source is local and from
 * `/api/workspace-moves/serve/*` when it is remote (the cloud, for a
 * cloud -> desktop move).
 *
 * Records are streamed as chunks rather than returned in one body: a workspace
 * with a million chat messages must not be buffered in a response, and the
 * driver has to be able to say "resume from ChatMessage row 40,000" after its
 * connection dropped.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspacesDir } from '../workspace-export/files'
import { insertOrder } from '../workspace-export/manifest'
import {
  cloudProjectFileManifest,
  cloudWorkspaceRootFileManifest,
  isWorkspaceRootPath,
  moveUsesCloudStorage,
  readCloudProjectFile,
  readCloudWorkspaceRootFile,
} from './cloud'
import { moveIgnoreRules } from './ignores'
import { moveDirFor, walkMoveFiles } from './files'
import { collectMoveRows } from './plan'
import { rewriteRowForMove, shouldMoveModel } from './records'
import type { HandoverKind } from './handover'
import { WORKSPACE_ROOT_ID, type MoveFileEntry, type MoveFileManifest, type MoveRow, type MoveSelection } from './types'

export const SERVE_CHUNK = 500

export interface SourceScope {
  workspaceId: string
  requesterId: string
  isOwner: boolean
  selection: MoveSelection
}

export interface RecordsChunk {
  model: string
  rows: MoveRow[]
  cursor: number
  done: boolean
}

/**
 * Stream every row a move carries, in insert order, chunk by chunk.
 *
 * `fromModel` / `cursor` resume a dropped stream: models before `fromModel` are
 * skipped and `fromModel` starts at `cursor`. Because the target writes
 * idempotently, re-sending a chunk that did land costs one skipped insert.
 */
export async function* streamSourceRecords(
  db: any,
  scope: SourceScope & { moveId: string; targetWorkspaceId: string },
  from: { model?: string; cursor?: number } = {},
): AsyncGenerator<RecordsChunk> {
  const { rows } = await collectMoveRows({ ...scope, db })
  // `User` leads: `Member` rows reference it by foreign key, and the export
  // manifest deliberately leaves `User` out, so it has to be prepended here or
  // the target writes a member before the account it points at exists.
  const order = [...new Set(['User', ...insertOrder()])].filter(
    (model) => shouldMoveModel(model) && (rows.get(model)?.length ?? 0) > 0,
  )

  // Rewriting happens here, once, on the side that knows every source id: the
  // stream carries target ids already, so the receiver writes rows verbatim and
  // a replayed chunk lands on the same primary keys.
  const movedIds = new Set<string>()
  for (const [model, list] of rows) {
    // User ids are not re-identified (see `rewriteRowForMove`), so a reference
    // to one must not be remapped either, or the member points at nothing.
    if (model === 'User') continue
    for (const row of list) movedIds.add(String(row.id))
  }
  const ctx = {
    moveId: scope.moveId,
    sourceWorkspaceId: scope.workspaceId,
    targetWorkspaceId: scope.targetWorkspaceId,
    movedIds,
  }
  const startIndex = from.model ? Math.max(0, order.indexOf(from.model)) : 0
  let doneAny = false

  for (let i = startIndex; i < order.length; i++) {
    const model = order[i]!
    const all = rows.get(model) ?? []
    const cursor = i === startIndex ? Math.max(0, from.cursor ?? 0) : 0
    for (let offset = cursor; offset < all.length; offset += SERVE_CHUNK) {
      const chunk = all.slice(offset, offset + SERVE_CHUNK)
      doneAny = true
      yield {
        model,
        rows: chunk.map((row) => rewriteRowForMove(model, row, ctx)),
        cursor: offset + chunk.length,
        done: false,
      }
    }
  }
  if (!doneAny) yield { model: from.model ?? '', rows: [], cursor: 0, done: true }
  else yield { model: '', rows: [], cursor: 0, done: true }
}

/**
 * Where a project's files live on the source: its checkout, or the managed dir.
 *
 * The workspace root is a pseudo-project (`WORKSPACE_ROOT_ID`) that lives at
 * `.workspace-roots/<id>` rather than under its own name, so it resolves through
 * `moveDirFor` and never consults `ProjectFolder`.
 */
export async function sourceProjectDir(
  db: any,
  workspaceId: string,
  projectId: string,
  base = workspacesDir(),
): Promise<{ dir: string; folderLinked: boolean }> {
  if (projectId === WORKSPACE_ROOT_ID || projectId.startsWith('.workspace-roots/')) {
    return { dir: moveDirFor({ projectId, workspaceId, base }), folderLinked: false }
  }
  const folder: { path: string } | null = await db.projectFolder
    .findFirst({ where: { projectId }, select: { path: true } })
    .catch(() => null)
  if (folder?.path) return { dir: folder.path, folderLinked: true }
  return { dir: join(base, projectId), folderLinked: false }
}

/** Every project id of a workspace, for the sources that need the whole set. */
export async function workspaceProjectIds(db: any, workspaceId: string): Promise<string[]> {
  const rows: Array<{ id: string }> = await db.project
    .findMany({ where: { workspaceId }, select: { id: true } })
    .catch(() => [])
  return (rows ?? []).map((row) => row.id)
}

/**
 * Everything the source holds for one project (or the workspace root), hashed.
 *
 * On Kubernetes there is no directory to walk: the project's files live in its
 * runtime pod and the workspace's own files in the merged workspace runtime, so
 * the manifest comes from the same sources export reads (`SHO-252`).
 */
export async function sourceFileManifest(
  db: any,
  input: { workspaceId: string; projectId: string; base?: string },
): Promise<MoveFileManifest> {
  if (moveUsesCloudStorage()) {
    if (isWorkspaceRootPath(input.projectId)) {
      return cloudWorkspaceRootFileManifest(
        input.workspaceId,
        await workspaceProjectIds(db, input.workspaceId),
      )
    }
    return cloudProjectFileManifest(input.projectId)
  }
  const base = input.base ?? workspacesDir()
  const { dir } = await sourceProjectDir(db, input.workspaceId, input.projectId, base)
  const walk = await walkMoveFiles(dir, { rules: moveIgnoreRules(dir), hash: true })
  const entries: MoveFileEntry[] = walk.entries
  return { projectId: input.projectId, entries, ignored: walk.ignored }
}

export function readSourceFileBytes(
  dir: string,
  relPath: string,
): Uint8Array {
  const safe = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!safe || safe.split('/').includes('..')) throw new Error(`unsafe path: ${relPath.slice(0, 120)}`)
  return new Uint8Array(readFileSync(join(dir, safe)))
}

/**
 * One file's bytes from the side that holds the workspace.
 *
 * Local sources read the directory `sourceProjectDir` resolved (a checkout for a
 * folder-linked project, `WORKSPACES_DIR/<id>` otherwise); a Kubernetes source
 * reads them from the runtime pod, because the API pod has no files of its own.
 */
export async function readSourceFile(
  db: any,
  input: { workspaceId: string; projectId: string; path: string; base?: string },
): Promise<Uint8Array> {
  if (moveUsesCloudStorage()) {
    if (isWorkspaceRootPath(input.projectId)) {
      return readCloudWorkspaceRootFile(
        input.workspaceId,
        await workspaceProjectIds(db, input.workspaceId),
        input.path,
      )
    }
    return readCloudProjectFile(input.projectId, input.path)
  }
  const { dir } = await sourceProjectDir(
    db,
    input.workspaceId,
    input.projectId,
    input.base ?? workspacesDir(),
  )
  return readSourceFileBytes(dir, input.path)
}

export async function setEnabledAtSource(
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
 * The "Moved to <target>" marker. The source is kept (decision D1), so this is
 * the only thing a switch over writes on this side apart from `enabled = false`.
 */
export async function markSourceMoved(
  db: any,
  sourceWorkspaceId: string,
  targetWorkspaceId: string | null,
): Promise<void> {
  await db.workspace.update({
    where: { id: sourceWorkspaceId },
    data: { movedToWorkspaceId: targetWorkspaceId, movedAt: targetWorkspaceId ? new Date() : null },
  })
}
