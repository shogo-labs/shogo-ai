// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Types shared by the workspace-move service, its routes and the desktop UI.
 *
 * A move is the same job in both directions: the desktop is always the driver
 * (`move.direction` only says which side reads and which side writes), so every
 * type here is direction-agnostic.
 */

import type { RequiredCredential } from '../../lib/export-secrets'

/**
 * The workspace's own root travels as a pseudo-project with this id.
 *
 * Its directory is `<base>/.workspace-roots/<workspaceId>`, not `<base>/<id>`
 * like a project, so anything that turns a `projectId` into a path must go
 * through `moveDirFor` rather than joining the id onto the base itself.
 */
export const WORKSPACE_ROOT_ID = '__workspace_root__'

export type MoveDirection = 'desktop_to_cloud' | 'cloud_to_desktop'

/**
 * `paused` is a status, not a phase: the job keeps its cursors and resumes from
 * them. `handover` is the last phase before `done` — schedules and triggers are
 * written disabled at the target and enabled at the source by "Switch over".
 */
export type MoveStatus =
  | 'planning'
  | 'records'
  | 'files'
  | 'handover'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

export type MoveSelection =
  | { mode: 'all' }
  | { mode: 'selected'; conversationIds: string[]; projectIds: string[] }

/** One row group a move will carry, after the selection closure ran. */
export interface MovePlanModel {
  model: string
  rows: number
}

/** How one project's code travels. */
export type ProjectMoveMode = 'copy' | 'git-relink'

export interface ProjectGitState {
  remote: string
  branch: string
  /** Files with uncommitted changes (staged, unstaged or untracked). */
  dirty: number
  /** Commits on the branch that the remote does not have. */
  unpushed: number
}

export interface MovePlanProject {
  /** Source project id. */
  id: string
  name: string
  mode: ProjectMoveMode
  /** Folder-linked projects only: where the checkout lives on the source. */
  folderPath?: string
  git?: ProjectGitState
  files: number
  bytes: number
  /** Bytes the ignore rules kept out of the move. */
  bytesIgnored: number
  filesIgnored: number
}

export interface MovePlan {
  direction: MoveDirection
  source: { workspaceId: string; name: string; kind: string }
  /**
   * `instanceSize` is frozen here because the target is created *by the job*,
   * which outlives the request. A resume with no size created the target at the
   * default size while the quota check had been made against this one.
   */
  target: { workspaceId?: string; name: string; instanceSize?: string | null }
  selection: {
    mode: MoveSelection['mode']
    conversations: Array<{ id: string; name: string; kind: string }>
    projects: Array<{ id: string; name: string }>
  }
  models: MovePlanModel[]
  totals: {
    models: number
    rows: number
    files: number
    bytes: number
    filesIgnored: number
    bytesIgnored: number
  }
  projects: MovePlanProject[]
  ignores: { rules: string[]; files: number; bytes: number }
  quota: { limitBytes: number | null; usedBytes: number; neededBytes: number; ok: boolean }
  /** What the user has to reconnect at the target; nothing secret travels. */
  credentials: RequiredCredential[]
  /** Schedules and triggers that arrive disabled. */
  handover: { schedules: number; triggers: number }
  warnings: string[]
}

/** Per-phase cursors, so a restart resumes instead of starting over. */
export interface MoveProgress {
  records?: { model: string; cursor: number }
  files?: { projectId: string; cursor: number }
  handover?: { done: boolean }
}

export interface MoveHandoverState {
  /** Source state of every schedule/trigger, keyed by the derived target id. */
  schedules: Array<{ targetId: string; sourceId: string; name: string; enabled: boolean }>
  triggers: Array<{ targetId: string; sourceId: string; name: string; enabled: boolean }>
  switchedOverAt?: string
}

/** A row as it travels: source ids already rewritten to their derived targets. */
export type MoveRow = Record<string, any>

export interface MoveRecordChunk {
  model: string
  rows: MoveRow[]
  cursor: number
  done: boolean
}

export interface MoveFileEntry {
  path: string
  bytes: number
  sha256: string
}

export interface MoveFileManifest {
  projectId: string
  entries: MoveFileEntry[]
  /** Bytes and files the ignore rules kept out. */
  ignored: { files: number; bytes: number }
}

export class WorkspaceMoveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'WorkspaceMoveError'
  }
}
