// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a move is allowed to touch, on one instance (SEC-18).
 *
 * A move's `/serve/*` and `/receive/*` halves take a `workspaceId` from the
 * caller and then receive a `projectId`, a model name and row ids from the other
 * side of the link. Until this file existed, nothing connected the two: every
 * user owns their personal workspace, so `workspace:move` passed, and after that
 * `projectId=../../..` was a path and an arbitrary model name was a table.
 *
 * Everything here answers one question — "is this thing inside the workspace
 * the caller was authorised for?" — and answers it the same way for the reading
 * side and the writing side, so the two cannot drift.
 */

import { resolve, sep } from 'node:path'
import { scopeFor } from '../workspace-export/manifest'
import { WORKSPACE_ROOT_ID, WorkspaceMoveError } from './types'
import type { MoveRow } from './types'

/** A project id is a plain id. Anything with a separator in it is a path. */
const PLAIN_ID = /^[A-Za-z0-9_-]+$/

/** The sentinel form `receive/files/*` accepts for one workspace's own root. */
const ROOT_PREFIX = '.workspace-roots/'

export function isPlainId(value: string): boolean {
  return PLAIN_ID.test(value)
}

function badProjectId(projectId: string): WorkspaceMoveError {
  return new WorkspaceMoveError(
    `"${String(projectId).slice(0, 80)}" is not a project id.`,
    400,
    'workspace_move_bad_project_id',
  )
}

function projectNotFound(projectId: string): WorkspaceMoveError {
  return new WorkspaceMoveError(
    `That project (${String(projectId).slice(0, 80)}) is not in this workspace.`,
    404,
    'workspace_move_project_not_found',
  )
}

/**
 * Resolve a `projectId` against the workspace the caller was authorised for.
 *
 * Three forms are legal, and only these three:
 *   - `WORKSPACE_ROOT_ID`, the workspace's own root — always in scope;
 *   - `.workspace-roots/<workspaceId>`, the same root addressed directly, **only
 *     for the authorised workspace** (it was `join(base, projectId)` before, so
 *     another workspace's root — and its `CLAUDE.md`, `.shogo/`, state files —
 *     was readable by naming it);
 *   - a plain id that has a `Project` row in this workspace.
 *
 * A project on the other side of a move must already exist here by the time its
 * files arrive: the records phase inserts the `Project` row (with its derived
 * id) before the files phase runs. That ordering is what makes the lookup safe
 * on the receive side as well as the serve side.
 */
export async function requireMoveProject(
  db: any,
  workspaceId: string,
  projectId: string,
): Promise<{ id: string; isRoot: boolean }> {
  if (!workspaceId) {
    throw new WorkspaceMoveError('A workspace id is required.', 400, 'workspace_required')
  }
  if (projectId === WORKSPACE_ROOT_ID) return { id: WORKSPACE_ROOT_ID, isRoot: true }
  if (projectId.startsWith(ROOT_PREFIX)) {
    const id = projectId.slice(ROOT_PREFIX.length)
    if (id !== workspaceId) throw projectNotFound(projectId)
    return { id: projectId, isRoot: true }
  }
  if (!isPlainId(projectId)) throw badProjectId(projectId)
  const project: { id: string } | null = await db.project
    .findFirst({ where: { id: projectId, workspaceId }, select: { id: true } })
    .catch(() => null)
  if (!project) throw projectNotFound(projectId)
  return { id: project.id, isRoot: false }
}

/**
 * Refuse a directory that lands outside the workspaces directory.
 *
 * Every `projectId` that reaches a path has already been through
 * `requireMoveProject`, so this cannot fire today — it is the second lock, for
 * the next caller that builds a path from a string it did not check.
 */
export function assertInsideWorkspacesDir(dir: string, base: string): string {
  const root = resolve(base)
  const target = resolve(dir)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new WorkspaceMoveError(
      'That path is outside the workspaces directory.',
      400,
      'workspace_move_unsafe_path',
    )
  }
  return target
}

// ─── Is this row inside the workspace? ────────────────────────────────
//
// A received row does not have to name the workspace it belongs to. Most of the
// models a move carries do not even have a `workspaceId` column: a
// `ChatMessage` belongs to a `ChatSession`, a `MessageFeedback` to a
// `ChatMessage`, a `ConversationAttachmentChunk` to an
// `ConversationAttachment` → `Conversation`. Checking a fixed list of foreign
// keys (`projectId`, `conversationId`, `boardId`) left the rest of the tree
// writable into another tenant — a `ChatMessage` naming a victim's `sessionId`
// landed in their transcript and their agent read it as history (SEC-18).
//
// So the chain is not listed here: it is read from the export manifest, which
// already classifies every model as scoped by a workspace, by a project, or by
// a parent row. A row is accepted only when walking its parents reaches a row
// that names **this** workspace.

/** How far up a parent chain a received row may be checked before we refuse. */
const MAX_PARENT_DEPTH = 8

/**
 * Models whose `workspaceId` is nullable, and where else to look when it is
 * empty. A `ChatSession` is workspace-scoped only for `contextType: workspace`;
 * a project or feature chat carries `contextId` and no workspace, so its
 * workspace is the one its project is in.
 */
const WORKSPACE_ID_FALLBACK: Record<string, readonly string[]> = {
  ChatSession: ['contextType', 'contextId'],
}

interface RowStep {
  model: string
  row: MoveRow
}

/**
 * Foreign keys that place a row inside workspace content, checked even when the
 * model's own scope is the workspace itself.
 *
 * The manifest chain says *how a row is scoped*; these three say *what a
 * workspace-scoped row hangs off*. A `Conversation` naming another workspace's
 * `projectId` is in the wrong tenant even though its own `workspaceId` is right,
 * and the same goes for a `WorkItem`'s `boardId`. Each target is itself
 * workspace-scoped, so one `where: { workspaceId }` answers it.
 */
const WORKSPACE_LINKS: ReadonlyArray<{ field: string; model: string }> = [
  { field: 'projectId', model: 'Project' },
  { field: 'conversationId', model: 'Conversation' },
  { field: 'boardId', model: 'Board' },
]

/** Either the row is in the workspace, or here is the parent to check next. */
type RowResolution = { done: true } | { done: false; model: string; id: string }

function clientFor(db: any, model: string): any {
  return db[model.charAt(0).toLowerCase() + model.slice(1)]
}

function foreignParent(model: string, field: string, id: unknown): WorkspaceMoveError {
  const named = String(id ?? '').slice(0, 60)
  return new WorkspaceMoveError(
    `A ${model} row refers to ${field} ${named || '(none)'}, which is not in this workspace.`,
    400,
    'workspace_move_foreign_parent',
  )
}

/** Only the columns the walk needs, so a transcript is never read for a check. */
function selectFor(model: string): Record<string, true> {
  const scope = scopeFor(model)
  const select: Record<string, true> = { id: true }
  if (!scope) return select
  if (scope.kind === 'workspace') {
    select.workspaceId = true
    for (const field of WORKSPACE_ID_FALLBACK[model] ?? []) select[field] = true
  }
  if (scope.kind === 'project') select.projectId = true
  if (scope.kind === 'parent') select[scope.field] = true
  return select
}

function resolveStep(step: RowStep, workspaceId: string): RowResolution {
  const { model, row } = step
  const scope = scopeFor(model)
  if (!scope) throw foreignParent(model, 'workspace', row?.id)

  if (scope.kind === 'workspace-row') {
    if (String(row.id ?? '') !== workspaceId) throw foreignParent(model, 'workspace', row.id)
    return { done: true }
  }
  if (scope.kind === 'workspace') {
    const own = row.workspaceId
    if (own != null && String(own) !== '') {
      if (String(own) !== workspaceId) throw foreignParent(model, 'workspaceId', own)
      return { done: true }
    }
    // No workspace on the row itself: fall back to the parent that carries it.
    if (model === 'ChatSession' && row.contextId) {
      if (row.contextType === 'project') return { done: false, model: 'Project', id: String(row.contextId) }
      if (row.contextType === 'feature') return { done: false, model: 'FeatureSession', id: String(row.contextId) }
    }
    throw foreignParent(model, 'workspaceId', own)
  }
  if (scope.kind === 'project') {
    if (!row.projectId) throw foreignParent(model, 'projectId', row.projectId)
    return { done: false, model: 'Project', id: String(row.projectId) }
  }
  const id = row[scope.field]
  if (typeof id !== 'string' || !id) throw foreignParent(model, scope.field, id)
  return { done: false, model: scope.parent, id }
}

/**
 * Refuse a row whose `projectId` / `conversationId` / `boardId` points at
 * another workspace's row (see `WORKSPACE_LINKS`).
 */
async function assertLinksInWorkspace(
  db: any,
  workspaceId: string,
  model: string,
  rows: readonly MoveRow[],
): Promise<void> {
  for (const link of WORKSPACE_LINKS) {
    const ids = [
      ...new Set(rows.map((row) => row[link.field]).filter((id) => typeof id === 'string' && id)),
    ] as string[]
    if (!ids.length) continue
    const client = clientFor(db, link.model)
    if (!client?.findMany) throw foreignParent(model, link.field, ids[0])
    const found: Array<{ id: string }> = await client.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true },
    })
    const known = new Set(found.map((row) => String(row.id)))
    const missing = ids.find((id) => !known.has(id))
    if (missing) throw foreignParent(model, link.field, missing)
  }
}

/**
 * Refuse a chunk when any row — or any row in its parent chain — is not in
 * `workspaceId`.
 *
 * The walk is level by level, one query per model per level, so a 500-row chunk
 * costs a handful of reads rather than one per row. A parent that does not
 * exist yet is refused, not skipped: the records phase sends parents before
 * children, so a missing parent means the row belongs somewhere this move is
 * not writing.
 */
export async function assertRowsInWorkspace(
  db: any,
  workspaceId: string,
  model: string,
  rows: readonly MoveRow[],
): Promise<void> {
  if (!workspaceId) {
    throw new WorkspaceMoveError('A workspace id is required.', 400, 'workspace_required')
  }
  const live = rows.filter((row) => row && typeof row === 'object')
  await assertLinksInWorkspace(db, workspaceId, model, live)

  /** `model:id` → the parent row, or null when it is not on this instance. */
  const cache = new Map<string, MoveRow | null>()
  /** `model:id` already shown to be in this workspace. */
  const proven = new Set<string>()
  let level: RowStep[] = live.map((row) => ({ model, row }))

  for (let depth = 0; depth <= MAX_PARENT_DEPTH && level.length; depth++) {
    const pending = new Map<string, Set<string>>()
    for (const step of level) {
      const resolved = resolveStep(step, workspaceId)
      if (resolved.done) {
        proven.add(`${step.model}:${String(step.row.id ?? '')}`)
        continue
      }
      const key = `${resolved.model}:${resolved.id}`
      if (proven.has(key) || cache.has(key)) continue
      const ids = pending.get(resolved.model) ?? new Set<string>()
      ids.add(resolved.id)
      pending.set(resolved.model, ids)
    }

    for (const [parentModel, ids] of pending) {
      const client = clientFor(db, parentModel)
      if (!client?.findMany) throw foreignParent(parentModel, 'id', [...ids][0])
      const found: MoveRow[] = await client.findMany({
        where: { id: { in: [...ids] } },
        select: selectFor(parentModel),
      })
      for (const id of ids) cache.set(`${parentModel}:${id}`, null)
      for (const row of found) cache.set(`${parentModel}:${String(row.id)}`, row)
    }

    const next: RowStep[] = []
    const queued = new Set<string>()
    for (const step of level) {
      const resolved = resolveStep(step, workspaceId)
      if (resolved.done) continue
      const key = `${resolved.model}:${resolved.id}`
      if (proven.has(key) || queued.has(key)) continue
      const row = cache.get(key)
      if (!row) throw foreignParent(resolved.model, 'id', resolved.id)
      queued.add(key)
      next.push({ model: resolved.model, row })
    }
    if (!next.length) return
    level = next
  }

  if (level.length) {
    throw new WorkspaceMoveError(
      'That row is nested too deeply to confirm it belongs to this workspace.',
      400,
      'workspace_move_foreign_parent',
    )
  }
}
