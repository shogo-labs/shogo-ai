// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The plan step: what a move would carry, before anything is copied.
 *
 * A move is irreversible enough (schedules stop, the source is marked moved)
 * that the user has to see the numbers first: rows per model, bytes per project,
 * what the ignore rules saved, what has to be reconnected, and whether the
 * target has room. This module computes exactly that and nothing else — the
 * runner re-collects the same snapshot when it starts.
 */

import { join } from 'node:path'
import { prisma } from '../../lib/prisma'
import { INSTANCE_SIZES, type InstanceSizeName } from '../../config/instance-sizes'
import { collectWorkspaceSnapshot } from '../workspace-export/export'
import { workspacesDir } from '../workspace-export/files'
import { applySelectionClosure, closureRuleFor } from './closure'
import { walkMoveFiles, moveDirFor } from './files'
import { inspectFolderLinkedProject } from './git'
import { describeIgnoreRules, moveIgnoreRules } from './ignores'
import type {
  MoveDirection,
  MoveFileEntry,
  MovePlan,
  MovePlanProject,
  MoveRow,
  MoveSelection,
} from './types'
import { WORKSPACE_ROOT_ID, WorkspaceMoveError } from './types'

/**
 * The workspace root travels as a pseudo-project with this id — re-exported so
 * callers keep importing it from here, while `files.ts` (the directory mapping)
 * takes the same constant from `types.ts` and no cycle forms.
 */
export { WORKSPACE_ROOT_ID }

export interface BuildMovePlanInput {
  workspaceId: string
  requesterId: string
  isOwner: boolean
  selection: MoveSelection
  direction: MoveDirection
  /** Where the move lands. A desktop target has no storage cap. */
  targetKind?: 'cloud' | 'desktop'
  targetName?: string
  db?: any
  /** Test seam: base directory that holds `<projectId>` directories. */
  projectsDirOverride?: string
  /** Test seam: skip walking project files (row counts only). */
  skipFiles?: boolean
  /**
   * The side that actually holds the workspace. Set for a move whose source is
   * remote (`cloud_to_desktop`): the plan must describe the source's rows and
   * files, not this instance's, which hold neither.
   */
  remote?: {
    planRows(scope: {
      workspaceId: string
      requesterId: string
      isOwner: boolean
      selection: MoveSelection
    }): Promise<{ rows: Record<string, MoveRow[]> }>
    fileManifest(input: { workspaceId: string; projectId: string }): Promise<{
      entries: MoveFileEntry[]
      ignored: { files: number; bytes: number }
    }>
  }
}

export interface MovePlanResult {
  plan: MovePlan
  /** The narrowed snapshot, so the runner does not collect it twice. */
  rows: Map<string, MoveRow[]>
}

export function normaliseSelection(raw: unknown): MoveSelection {
  if (!raw || typeof raw !== 'object') return { mode: 'all' }
  const value = raw as any
  if (value.mode === 'all' || value.mode === undefined) return { mode: 'all' }
  if (value.mode !== 'selected') {
    throw new WorkspaceMoveError(`Unknown selection mode "${String(value.mode)}"`, 400, 'workspace_move_bad_selection')
  }
  const conversationIds: string[] = Array.isArray(value.conversationIds)
    ? value.conversationIds.filter((id: unknown): id is string => typeof id === 'string' && !!id)
    : []
  const projectIds: string[] = Array.isArray(value.projectIds)
    ? value.projectIds.filter((id: unknown): id is string => typeof id === 'string' && !!id)
    : []
  if (!conversationIds.length && !projectIds.length) {
    throw new WorkspaceMoveError(
      'Pick at least one channel or project to move, or move the whole workspace.',
      400,
      'workspace_move_empty_selection',
    )
  }
  return { mode: 'selected', conversationIds: [...new Set(conversationIds)], projectIds: [...new Set(projectIds)] }
}

export interface MoveRowsResult {
  rows: Map<string, MoveRow[]>
  credentials: MovePlan['credentials']
  warnings: string[]
  droppedDms: number
}

/**
 * The workspace snapshot, narrowed to the selection. One collection, so the
 * plan step and the records phase cannot disagree about what is in the move.
 */
export async function collectMoveRows(input: {
  workspaceId: string
  requesterId: string
  isOwner: boolean
  selection: MoveSelection
  db?: any
}): Promise<MoveRowsResult> {
  const snapshot = await collectWorkspaceSnapshot({
    workspaceId: input.workspaceId,
    requesterId: input.requesterId,
    isOwner: input.isOwner,
    options: { includeAllDms: input.isOwner, includeAttachments: true },
    db: input.db,
  } as any)
  const closure = applySelectionClosure(snapshot.rows, input.selection)
  await attachReferencedUsers(input.db ?? prisma, closure.rows)
  return {
    rows: closure.rows,
    credentials: snapshot.credentials,
    warnings: snapshot.warnings,
    droppedDms: snapshot.droppedDms,
  }
}

/**
 * Columns that hold a `User` id.
 *
 * `User` is excluded from the export manifest on purpose — it is global account
 * data, not workspace content — but rows all over a workspace point at it by
 * foreign key: a member, the author of a message, the uploader of an
 * attachment, the person who archived a doc. A move therefore carries a
 * minimal user row for every id these columns mention.
 *
 * Without them the target fails with `Foreign key constraint violated` on the
 * first row whose user is not a member. On a seeded test workspace that is
 * nobody; on a real one it is the first message written by anyone who has since
 * left, and the whole move dies there — a real cloud workspace's first attempt
 * failed on `ConversationMember` for exactly this. Only the columns an identity
 * needs travel; the profile stays the account's own business.
 */
const USER_ID_COLUMNS = [
  'userId',
  'authorUserId',
  'uploaderUserId',
  'targetUserId',
  'actorUserId',
  'assigneeUserId',
  'addedByUserId',
  'invitedById',
  'referredUserId',
  'ownerUserId',
  'createdById',
  'createdByUserId',
  'updatedById',
  'updatedByUserId',
  'archivedByUserId',
] as const

async function attachReferencedUsers(db: any, rows: Map<string, MoveRow[]>): Promise<void> {
  const ids = new Set<string>()
  for (const list of rows.values()) {
    for (const row of list) {
      for (const column of USER_ID_COLUMNS) {
        const value = (row as any)?.[column]
        if (typeof value === 'string' && value) ids.add(value)
      }
    }
  }
  if (!ids.size) return
  const carried = new Set((rows.get('User') ?? []).map((user) => String(user.id)))
  const missing = [...ids].filter((id) => !carried.has(id))
  if (!missing.length) return
  const users: MoveRow[] = await db.user
    .findMany({
      where: { id: { in: missing } },
      select: { id: true, email: true, name: true, image: true },
    })
    .catch(() => [])
  if (users.length) rows.set('User', [...(rows.get('User') ?? []), ...users])
}

interface ProjectRow {
  id: string
  name: string
}

async function loadProjects(db: any, workspaceId: string, selection: MoveSelection): Promise<ProjectRow[]> {
  const projects: ProjectRow[] = await db.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
  if (selection.mode === 'all') return projects
  const wanted = new Set(selection.projectIds)
  return projects.filter((project) => wanted.has(project.id))
}

async function loadConversations(
  db: any,
  workspaceId: string,
  selection: MoveSelection,
): Promise<Array<{ id: string; name: string; kind: string }>> {
  const conversations: Array<{ id: string; name: string; kind: string }> = await db.conversation.findMany({
    where: { workspaceId },
    select: { id: true, name: true, kind: true },
    orderBy: { createdAt: 'asc' },
  })
  if (selection.mode === 'all') return conversations
  const wanted = new Set(selection.conversationIds)
  return conversations.filter((conversation) => wanted.has(conversation.id))
}

async function projectFolderPaths(db: any, projectIds: string[]): Promise<Map<string, string>> {
  if (!projectIds.length) return new Map()
  const folders: Array<{ projectId: string; path: string }> = await db.projectFolder
    .findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, path: true } })
    .catch(() => [])
  return new Map(folders.map((folder) => [folder.projectId, folder.path]))
}

async function targetStorageLimit(input: BuildMovePlanInput): Promise<number | null> {
  if (input.targetKind === 'desktop') return null
  const workspace: { instanceSize?: string } | null = await (input.db ?? prisma).workspace.findUnique({
    where: { id: input.workspaceId },
    select: { instanceSize: true },
  })
  const size = (workspace?.instanceSize ?? 'micro') as InstanceSizeName
  return INSTANCE_SIZES[size]?.storageLimitBytes ?? null
}

/**
 * Build the plan. Nothing is written; the caller shows it and then starts the
 * job with the same selection.
 */
export async function buildMovePlan(input: BuildMovePlanInput): Promise<MovePlanResult> {
  const db: any = input.db ?? prisma
  // A remote source *is* the workspace: this instance holds neither its rows
  // nor its files. Building the plan locally planned an empty move (zero
  // projects, zero bytes) and then reported success with an empty target.
  const remoteRows = input.remote
    ? new Map<string, MoveRow[]>(
        Object.entries(
          (
            await input.remote.planRows({
              workspaceId: input.workspaceId,
              requesterId: input.requesterId,
              isOwner: input.isOwner,
              selection: input.selection,
            })
          ).rows,
        ),
      )
    : null

  const remoteWorkspaceRow = remoteRows ? (remoteRows.get('Workspace') ?? [])[0] : undefined
  const workspace = remoteRows
    ? {
        id: input.workspaceId,
        name: String(remoteWorkspaceRow?.name ?? input.targetName ?? 'Workspace'),
        kind: String(remoteWorkspaceRow?.kind ?? 'team'),
        instanceSize: (remoteWorkspaceRow?.instanceSize as string | null) ?? null,
      }
    : await db.workspace.findUnique({
        where: { id: input.workspaceId },
        // `instanceSize` is here because the plan freezes it for the target: without
        // it every move created a `micro` workspace (the column default) no matter
        // what the source was, while the quota check above still read the real size.
        select: { id: true, name: true, kind: true, instanceSize: true },
      })
  if (!workspace) throw new WorkspaceMoveError('Workspace not found', 404, 'workspace_not_found')

  const collected = remoteRows
    ? { rows: remoteRows, credentials: [] as any[], warnings: [] as string[], droppedDms: 0 }
    : await collectMoveRows({ ...input, db })
  const rows = collected.rows
  const models = [...rows.entries()].map(([model, list]) => ({ model, rows: list.length }))
  const totalRows = models.reduce((sum, entry) => sum + entry.rows, 0)

  const wantedProjects = input.selection.mode === 'all' ? null : new Set(input.selection.projectIds)
  const projects: ProjectRow[] = remoteRows
    ? (remoteRows.get('Project') ?? [])
        .map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
        .filter((project) => !wantedProjects || wantedProjects.has(project.id))
    : await loadProjects(db, input.workspaceId, input.selection)
  const conversations = remoteRows ? [] : await loadConversations(db, input.workspaceId, input.selection)
  const folders = remoteRows
    ? new Map<string, string>()
    : await projectFolderPaths(
        db,
        projects.map((project) => project.id),
      )

  const warnings: string[] = []
  const planProjects: MovePlanProject[] = []
  const projectsBase = input.projectsDirOverride ?? workspacesDir()
  let totalFiles = 0
  let totalBytes = 0
  let ignoredFiles = 0
  let ignoredBytes = 0

  if (!input.skipFiles) {
    for (const project of projects) {
      const folderPath = folders.get(project.id) ?? null
      const sourceDir = folderPath ?? join(projectsBase, project.id)
      const gitState = folderPath ? inspectFolderLinkedProject(folderPath) : null
      const mode = gitState?.isRepo && gitState.remote ? 'git-relink' : 'copy'

      if (mode === 'git-relink' && gitState) {
        if (gitState.dirty > 0) {
          warnings.push(
            `${project.name}: ${gitState.dirty} uncommitted change(s) in ${folderPath} will not travel — commit and push them first if they belong to the project.`,
          )
        }
        if (gitState.unpushed > 0) {
          warnings.push(
            `${project.name}: ${gitState.unpushed} commit(s) on ${gitState.branch ?? 'this branch'} are not pushed to ${gitState.remote}; the target clones the remote, so they would be missing.`,
          )
        }
      }
      if (mode === 'copy' && folderPath) {
        warnings.push(
          `${project.name} is folder-linked but has no git remote, so its files are copied and it becomes a managed project at the target.`,
        )
      }

      const walk = input.remote
        ? await input.remote
            .fileManifest({ workspaceId: input.workspaceId, projectId: project.id })
            .then((manifest) => ({ entries: manifest.entries, ignored: manifest.ignored, errors: [] as string[] }))
        : mode === 'git-relink'
          ? { entries: [], ignored: { files: 0, bytes: 0 }, errors: [] }
          : await walkMoveFiles(sourceDir, { rules: moveIgnoreRules(folderPath ?? sourceDir), hash: false })

      const files = walk.entries.length
      const bytes = walk.entries.reduce((sum, entry) => sum + entry.bytes, 0)
      totalFiles += files
      totalBytes += bytes
      ignoredFiles += walk.ignored.files
      ignoredBytes += walk.ignored.bytes
      if (walk.errors.length) {
        warnings.push(`${project.name}: ${walk.errors.length} path(s) could not be read and will be skipped.`)
      }

      planProjects.push({
        id: project.id,
        name: project.name,
        mode,
        folderPath: folderPath ?? undefined,
        git: gitState?.remote
          ? {
              remote: gitState.remote,
              branch: gitState.branch ?? 'HEAD',
              dirty: gitState.dirty,
              unpushed: gitState.unpushed,
            }
          : undefined,
        files,
        bytes,
        filesIgnored: walk.ignored.files,
        bytesIgnored: walk.ignored.bytes,
      })
    }

    // The workspace's own root travels too (its `CLAUDE.md`, `.shogo/`, any file
    // outside a project), as the `WORKSPACE_ROOT_ID` pseudo-project. It was left
    // out of the plan entirely, so its bytes were missing from the totals and
    // from the quota check — the one number the user approves before starting.
    const rootDir = moveDirFor({ projectId: WORKSPACE_ROOT_ID, workspaceId: input.workspaceId, base: projectsBase })
    const rootWalk = input.remote
      ? await input.remote
          .fileManifest({ workspaceId: input.workspaceId, projectId: WORKSPACE_ROOT_ID })
          .then((manifest) => ({ entries: manifest.entries, ignored: manifest.ignored, errors: [] as string[] }))
      : await walkMoveFiles(rootDir, { rules: moveIgnoreRules(rootDir), hash: false })
    const rootBytes = rootWalk.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    totalFiles += rootWalk.entries.length
    totalBytes += rootBytes
    ignoredFiles += rootWalk.ignored.files
    ignoredBytes += rootWalk.ignored.bytes
    if (rootWalk.errors.length) {
      warnings.push(`The workspace root: ${rootWalk.errors.length} path(s) could not be read and will be skipped.`)
    }
    // Only listed when it has something in it: an empty root is not a project,
    // and a permanent "(workspace root) — 0 bytes" row is noise in the plan.
    if (rootWalk.entries.length) {
      planProjects.push({
        id: WORKSPACE_ROOT_ID,
        name: '(workspace root)',
        mode: 'copy',
        files: rootWalk.entries.length,
        bytes: rootBytes,
        filesIgnored: rootWalk.ignored.files,
        bytesIgnored: rootWalk.ignored.bytes,
      })
    }
  }

  const handoverSchedules = (rows.get('AgentSchedule') ?? []).length
  const handoverTriggers = (rows.get('EventSubscription') ?? []).length

  const limitBytes = await targetStorageLimit(input)
  const usedBytes = 0
  const quotaOk = limitBytes === null || totalBytes <= limitBytes
  if (!quotaOk) {
    warnings.push(
      `The move needs ${formatBytes(totalBytes)} and the target allows ${formatBytes(limitBytes ?? 0)}. Free space or pick a larger target before starting.`,
    )
  }

  for (const warning of collected.warnings) warnings.push(warning)
  if (collected.droppedDms > 0) {
    warnings.push(`${collected.droppedDms} direct message(s) you are not a member of stay behind.`)
  }
  const attachments = (rows.get('ConversationAttachment') ?? []).length + (rows.get('ChatAttachment') ?? []).length
  if (attachments > 0) {
    warnings.push(
      `${attachments} chat attachment(s) travel as records only: their bytes live in object storage and are not copied by a move. Re-upload them at the target if they matter.`,
    )
  }

  const plan: MovePlan = {
    direction: input.direction,
    source: { workspaceId: workspace.id, name: workspace.name, kind: String(workspace.kind ?? 'team') },
    target: {
      name: input.targetName?.trim() || `${workspace.name} (moved)`,
      // Frozen into the approved plan: the job creates the target later, and on
      // a resume there is no request to carry the size.
      instanceSize: workspace.instanceSize ?? null,
    },
    selection: {
      mode: input.selection.mode,
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        name: conversation.name,
        kind: String(conversation.kind ?? 'channel'),
      })),
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
    },
    models,
    totals: {
      models: models.length,
      rows: totalRows,
      files: totalFiles,
      bytes: totalBytes,
      filesIgnored: ignoredFiles,
      bytesIgnored: ignoredBytes,
    },
    projects: planProjects,
    ignores: {
      rules: describeIgnoreRules(moveIgnoreRules()),
      files: ignoredFiles,
      bytes: ignoredBytes,
    },
    quota: { limitBytes, usedBytes, neededBytes: totalBytes, ok: quotaOk },
    credentials: collected.credentials,
    handover: { schedules: handoverSchedules, triggers: handoverTriggers },
    warnings,
  }

  return { plan, rows }
}

/** Storage numbers are shown to a person, so they are rounded, not exact. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Which models a partial move would leave behind, for the plan step's tree. */
export function modelsInSelection(rows: Map<string, MoveRow[]>): string[] {
  return [...rows.keys()].filter((model) => closureRuleFor(model) !== null)
}
