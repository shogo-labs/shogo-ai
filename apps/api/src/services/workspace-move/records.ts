// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turning source rows into target rows.
 *
 * Everything here is a pure function of (row, move context) on purpose: the
 * records phase can then re-send any chunk after a dropped connection and land
 * exactly the same rows, which is what makes a resumable move safe.
 *
 * What changes on the way across:
 *   - `id` and every foreign key that points at a row being moved get the
 *     derived id from `ids.ts` (never a stored map);
 *   - `workspaceId` becomes the target workspace;
 *   - `AgentSchedule.enabled` / `EventSubscription.enabled` are forced off, so
 *     nothing runs twice between the copy landing and "Switch over";
 *   - `ProjectFolder` rows are dropped: the target decides where a checkout
 *     lives (clone path for a git re-link, the managed dir for a copy), and a
 *     source machine's path means nothing on the other side.
 */

import { deriveMoveId } from './ids'
import type { MoveRow } from './types'

/** Rows per chunk. Big enough to amortise a round trip, small enough to retry. */
export const MOVE_RECORD_CHUNK = 500

export interface RewriteContext {
  moveId: string
  sourceWorkspaceId: string
  targetWorkspaceId: string
  /** Every source id that is being moved, so FKs can be told from user ids. */
  movedIds: ReadonlySet<string>
}

/** Columns that name an account or an outside system, never a moved row. */
const NEVER_REMAPPED = new Set(['workspaceId', 'userId', 'createdById', 'ownerUserId', 'authorUserId', 'installId'])

export function rewriteRowForMove(model: string, row: MoveRow, ctx: RewriteContext): MoveRow {
  const next: MoveRow = { ...row }
  const sourceId = String(row?.id ?? '')
  if (sourceId) next.id = deriveMoveId(ctx.moveId, sourceId)

  if (next.workspaceId === ctx.sourceWorkspaceId) next.workspaceId = ctx.targetWorkspaceId

  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || typeof value !== 'string' || !value) continue
    if (key === 'workspaceId') continue
    if (!key.endsWith('Id') || NEVER_REMAPPED.has(key)) continue
    if (ctx.movedIds.has(value)) next[key] = deriveMoveId(ctx.moveId, value)
  }

  if (model === 'AgentSchedule') {
    // Disabled until "Switch over"; the source keeps its own state until then.
    next.enabled = false
    // A stale "this run is in progress" marker must not follow the row.
    next.runningAt = null
    next.consecutiveFailures = 0
    next.lastError = null
  }
  if (model === 'EventSubscription') next.enabled = false
  if (model === 'Workspace') {
    // Move bookkeeping belongs to the source copy: it is the one that stayed
    // behind and points at the workspace that took over. The target is live and
    // must not inherit a "Moved to" pointer at itself.
    next.movedToWorkspaceId = null
    next.movedAt = null
  }

  return next
}

/**
 * Rows that never travel, because the target writes its own authoritative copy.
 *
 * `ProjectFolder` is recreated at the target (it is a path on that machine).
 * `Workspace` is created by `initTargetWorkspace` before the records phase runs:
 * the source row is a partial projection (`collectWorkspaceSnapshot` selects
 * only `{ id, name, kind }`) and inserting it would both fail on the required
 * `slug` and duplicate the workspace the target already has. It was invisible
 * until now because the zip import creates its own workspace and never inserts
 * one either — so this path had no coverage at all.
 */
const NOT_MOVED: ReadonlySet<string> = new Set(['ProjectFolder', 'Workspace'])

export function shouldMoveModel(model: string): boolean {
  return !NOT_MOVED.has(model)
}

export function chunkRows<T>(rows: readonly T[], size = MOVE_RECORD_CHUNK): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const chunks: T[][] = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

/**
 * Rewrite a whole model's rows and chunk them. Used by the source side of the
 * records phase and by the tests that assert idempotency.
 */
export function prepareModelRows(
  model: string,
  rows: readonly MoveRow[],
  ctx: RewriteContext,
  chunkSize = MOVE_RECORD_CHUNK,
): MoveRow[][] {
  if (!shouldMoveModel(model)) return []
  return chunkRows(
    rows.map((row) => rewriteRowForMove(model, row, ctx)),
    chunkSize,
  )
}
