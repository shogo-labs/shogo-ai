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
import { WORKSPACE_ROOT_ID, WorkspaceMoveError } from './types'

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
