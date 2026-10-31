// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The move runner: one job, four resumable phases.
 *
 *   records  → rows, model by model, chunk by chunk
 *   files    → project by project, file by file, against a hash manifest
 *   handover → schedules and triggers stay disabled; nothing runs twice
 *   done
 *
 * Every phase writes its cursor through `onProgress` *before* it moves on, so a
 * killed process resumes where it stopped rather than from the beginning. That
 * is the whole reason a move is a database row and not a request.
 *
 * The runner does not know which side is local: it talks to a `MoveSource` and a
 * `MoveTarget` (see `link.ts`), which is how desktop -> cloud and
 * cloud -> desktop share one code path.
 */

import { diffFileManifest } from './files'
import type { HandoverKind } from './handover'
import { deriveMoveId } from './ids'
import type { MoveSource, MoveTarget } from './link'
import { WORKSPACE_ROOT_ID } from './plan'
import type {
  MoveDirection,
  MoveHandoverState,
  MovePlan,
  MoveProgress,
  MoveSelection,
} from './types'
import { WorkspaceMoveError } from './types'

export type MoveControl = () => Promise<'run' | 'pause' | 'cancel'>

export interface RunnerProgressPatch {
  progress?: MoveProgress
  targetWorkspaceId?: string
  rowsCopied?: number
  filesCopied?: number
  bytesCopied?: number
}

export interface RunnerInput {
  moveId: string
  direction: MoveDirection
  source: MoveSource
  target: MoveTarget
  sourceWorkspaceId: string
  targetWorkspaceId: string | null
  requesterId: string
  isOwner: boolean
  ownerUserId: string
  selection: MoveSelection
  plan: MovePlan
  progress: MoveProgress
  handover: MoveHandoverState
  control?: MoveControl
  onProgress?: (patch: RunnerProgressPatch) => Promise<void>
  log?: (line: string) => void
}

export interface RunnerResult {
  targetWorkspaceId: string
  progress: MoveProgress
  rowsCopied: number
  filesCopied: number
  bytesCopied: number
  stopped: 'pause' | 'cancel' | null
}

/** Thrown when the user paused or cancelled; the caller keeps the cursors. */
export class MoveStopped extends Error {
  constructor(readonly reason: 'pause' | 'cancel') {
    super(reason === 'pause' ? 'Move paused' : 'Move cancelled')
    this.name = 'MoveStopped'
  }
}

export async function runMove(input: RunnerInput): Promise<RunnerResult> {
  const log = input.log ?? (() => {})
  let targetWorkspaceId = input.targetWorkspaceId
  let progress: MoveProgress = { ...input.progress }
  let rowsCopied = 0
  let filesCopied = 0
  let bytesCopied = 0
  let stopped: 'pause' | 'cancel' | null = null

  const checkControl = async () => {
    if (!input.control) return
    const state = await input.control()
    if (state === 'run') return
    stopped = state
    throw new MoveStopped(state)
  }

  const save = async (patch: RunnerProgressPatch) => {
    if (patch.progress) progress = patch.progress
    if (patch.rowsCopied) rowsCopied += patch.rowsCopied
    if (patch.filesCopied) filesCopied += patch.filesCopied
    if (patch.bytesCopied) bytesCopied += patch.bytesCopied
    if (patch.targetWorkspaceId) targetWorkspaceId = patch.targetWorkspaceId
    await input.onProgress?.({ ...patch, progress })
  }

  try {
    // ── 1. target workspace ────────────────────────────────────────
    if (!targetWorkspaceId) {
      // No size on the wire: the target gets its own default, exactly like a
      // normal workspace create (SHO-256). A bigger runtime is the plan/billing
      // flow's call, not the move's.
      const created = await input.target.init({
        name: input.plan.target.name,
        sourceWorkspaceId: input.sourceWorkspaceId,
        ownerUserId: input.ownerUserId,
      })
      targetWorkspaceId = created.workspaceId
      await save({ targetWorkspaceId })
      log(`created target workspace ${targetWorkspaceId}`)
    }

    // ── 2. records ────────────────────────────────────────────────
    const stream = input.source.streamRecords(
      {
        workspaceId: input.sourceWorkspaceId,
        requesterId: input.requesterId,
        isOwner: input.isOwner,
        selection: input.selection,
        moveId: input.moveId,
        targetWorkspaceId,
      },
      { model: progress.records?.model, cursor: progress.records?.cursor },
    )
    for await (const chunk of stream) {
      await checkControl()
      if (chunk.done) break
      if (!chunk.rows.length) continue
      await input.target.writeRecords({
        workspaceId: targetWorkspaceId,
        model: chunk.model,
        rows: chunk.rows,
      })
      await save({
        progress: { ...progress, records: { model: chunk.model, cursor: chunk.cursor } },
        rowsCopied: chunk.rows.length,
      })
    }
    log(`records done (${rowsCopied} rows)`)

    // ── 3. files ──────────────────────────────────────────────────
    const projects: Array<{
      id: string
      name: string
      mode: 'copy' | 'git-relink'
      git?: { remote: string; branch: string }
    }> = [
      { id: WORKSPACE_ROOT_ID, name: '(workspace root)', mode: 'copy' },
      // The plan lists the workspace root too (its bytes count against the
      // quota), so drop it here rather than walking and hashing it twice.
      ...input.plan.projects
        .filter((project) => project.id !== WORKSPACE_ROOT_ID)
        .map((project) => ({
          id: project.id,
          name: project.name,
          mode: project.mode,
          git: project.git ? { remote: project.git.remote, branch: project.git.branch } : undefined,
        })),
    ]

    const doneProjects = new Set<string>()
    if (progress.files?.projectId) {
      const index = projects.findIndex((project) => project.id === progress.files?.projectId)
      for (let i = 0; i < index; i++) doneProjects.add(projects[i]!.id)
    }

    for (const project of projects) {
      if (doneProjects.has(project.id)) continue
      await checkControl()
      // The records phase gave the target's `Project` row a derived id, so the
      // bytes have to land under *that* id: `workspaces/<derivedId>`. Using the
      // source id here wrote every file into a directory no `Project` row points
      // at, and in a same-instance move it silently overwrote the source's own
      // files. The workspace root is the one exception — it keeps its sentinel,
      // which `moveDirFor` maps to `.workspace-roots/<workspaceId>`.
      const targetProjectId =
        project.id === WORKSPACE_ROOT_ID ? WORKSPACE_ROOT_ID : deriveMoveId(input.moveId, project.id)

      if (project.mode === 'git-relink' && project.git) {
        await input.target.relink({
          workspaceId: targetWorkspaceId,
          projectId: targetProjectId,
          name: project.name,
          remote: project.git.remote,
          branch: project.git.branch,
        })
        log(`re-linked ${project.name} from ${project.git.remote}`)
        await save({ progress: { ...progress, files: { projectId: project.id, cursor: 0 } } })
        continue
      }

      const sourceManifest = await input.source.fileManifest({
        workspaceId: input.sourceWorkspaceId,
        projectId: project.id,
      })
      const targetManifest = await input.target.fileManifest({
        workspaceId: targetWorkspaceId,
        projectId: targetProjectId,
      })
      const diff = diffFileManifest(sourceManifest.entries, targetManifest.entries)
      if (diff.skipped) log(`${project.name}: ${diff.skipped} file(s) already at the target`)

      let sent = 0
      for (const entry of diff.toSend) {
        await checkControl()
        const bytes = await input.source.readFile({
          workspaceId: input.sourceWorkspaceId,
          projectId: project.id,
          path: entry.path,
        })
        await input.target.writeFile({
          workspaceId: targetWorkspaceId,
          projectId: targetProjectId,
          path: entry.path,
          bytes,
        })
        sent++
        await save({
          progress: { ...progress, files: { projectId: project.id, cursor: sent } },
          filesCopied: 1,
          bytesCopied: bytes.byteLength,
        })
      }
      log(`${project.name}: ${sent} file(s) sent, ${diff.skipped} skipped`)
      await save({ progress: { ...progress, files: { projectId: project.id, cursor: sent } } })

      // The files are on the target's disk; hand them to the store its runtime
      // actually reads (S3 on cloud, a no-op on a desktop) before moving on, so
      // a failure here fails the move instead of leaving files nobody can open.
      const flushed = await input.target.flushFiles({
        workspaceId: targetWorkspaceId,
        projectId: targetProjectId,
      })
      for (const notice of flushed?.notices ?? []) {
        if (!(progress.notices ?? []).includes(notice)) {
          await save({ progress: { ...progress, notices: [...(progress.notices ?? []), notice] } })
          log(`note: ${notice}`)
        }
      }
    }

    // ── 4. handover ───────────────────────────────────────────────
    // The schedules and triggers are already at the target, disabled. "Switch
    // over" is what turns them on — this phase only proves they are off, so a
    // move can never leave a live copy behind.
    for (const kind of ['schedule', 'trigger'] as const) {
      const ids = handoverIds(input.handover, kind)
      if (ids.length) {
        await input.target.setEnabled({ workspaceId: targetWorkspaceId, kind, ids, enabled: false })
      }
    }
    await save({ progress: { ...progress, handover: { done: true } } })

    return { targetWorkspaceId, progress, rowsCopied, filesCopied, bytesCopied, stopped: null }
  } catch (err) {
    if (err instanceof MoveStopped) {
      return { targetWorkspaceId: targetWorkspaceId ?? '', progress, rowsCopied, filesCopied, bytesCopied, stopped: err.reason }
    }
    throw err
  }
}

function handoverIds(state: MoveHandoverState, kind: HandoverKind): string[] {
  return (kind === 'schedule' ? state.schedules : state.triggers).map((row) => row.targetId)
}

/** Guard for the routes: a move with nothing selected would be a no-op. */
export function assertMoveStartable(plan: MovePlan): void {
  if (plan.totals.rows === 0 && plan.totals.files === 0) {
    throw new WorkspaceMoveError('There is nothing in this selection to move.', 400, 'workspace_move_empty')
  }
}
