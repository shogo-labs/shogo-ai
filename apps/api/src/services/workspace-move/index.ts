// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Orchestration for a workspace move: the row, the job, and the two switches.
 *
 * The desktop is always the driver, in both directions, because the cloud
 * cannot reach a laptop. So the job row lives on the desktop's database, the
 * remote end is always Shogo Cloud (addressed with the signed-in `SHOGO_API_KEY`
 * — the same credential the cloud-content sync uses), and `direction` decides
 * only which end is read and which is written.
 *
 * A job is fire-and-forget from the request that starts it, but it is not
 * lost if the process dies: `kickMove` restarts any row that says it is running
 * with no job in this process, and every phase resumes from its cursor.
 */

import { prisma } from '../../lib/prisma'
import { buildHandover, readHandover, switchBack, switchOver } from './handover'
import { HttpMoveSource, HttpMoveTarget, LocalMoveSource, LocalMoveTarget, type MoveSource, type MoveTarget } from './link'
import { buildMovePlan, collectMoveRows, normaliseSelection } from './plan'
import { runMove } from './runner'
import type {
  MoveDirection,
  MovePlan,
  MoveProgress,
  MoveSelection,
  MoveStatus,
} from './types'
import { WorkspaceMoveError } from './types'

const running = new Map<string, Promise<void>>()

export interface MoveEndpoints {
  source: MoveSource
  target: MoveTarget
  /** True when this process is the side that holds the remote credential. */
  remote: 'cloud' | 'desktop'
}

function remoteOptions(moveId: string) {
  const apiUrl = process.env.SHOGO_API_URL
  const apiKey = process.env.SHOGO_API_KEY
  if (!apiUrl || !apiKey) {
    throw new WorkspaceMoveError(
      'A move needs a signed-in Shogo Cloud account. Sign in from Shogo Desktop and try again.',
      412,
      'workspace_move_not_signed_in',
    )
  }
  return { apiUrl, apiKey, moveId }
}

/**
 * Wire the two ends for a direction. `direction` is from the driver's point of
 * view: `desktop_to_cloud` means this process is the desktop.
 */
export function endpointsFor(direction: MoveDirection, moveId: string, db: any = prisma): MoveEndpoints {
  const remote = remoteOptions(moveId)
  if (direction === 'desktop_to_cloud') {
    return { source: new LocalMoveSource(db), target: new HttpMoveTarget(remote), remote: 'cloud' }
  }
  if (direction === 'cloud_to_desktop') {
    return { source: new HttpMoveSource(remote), target: new LocalMoveTarget(db), remote: 'cloud' }
  }
  throw new WorkspaceMoveError(`Unknown direction "${String(direction)}"`, 400, 'workspace_move_bad_direction')
}

export async function planMove(input: {
  workspaceId: string
  requesterId: string
  isOwner: boolean
  direction: MoveDirection
  selection: unknown
  targetKind?: 'cloud' | 'desktop'
  targetName?: string
  db?: any
}): Promise<MovePlan> {
  const selection = normaliseSelection(input.selection)
  const { plan } = await buildMovePlan({
    workspaceId: input.workspaceId,
    requesterId: input.requesterId,
    isOwner: input.isOwner,
    selection,
    direction: input.direction,
    targetKind: input.targetKind,
    targetName: input.targetName,
    db: input.db,
  })
  return plan
}

export async function createMove(input: {
  workspaceId: string
  requesterId: string
  isOwner: boolean
  direction: MoveDirection
  selection: unknown
  targetName?: string
  targetKind?: 'cloud' | 'desktop'
  db?: any
}): Promise<{ move: any; plan: MovePlan }> {
  const db: any = input.db ?? prisma
  const selection = normaliseSelection(input.selection)
  const workspace = await db.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { id: true, name: true, instanceSize: true },
  })
  if (!workspace) throw new WorkspaceMoveError('Workspace not found', 404, 'workspace_not_found')

  const { plan, rows } = await buildMovePlan({
    workspaceId: input.workspaceId,
    requesterId: input.requesterId,
    isOwner: input.isOwner,
    selection,
    direction: input.direction,
    targetKind: input.targetKind,
    targetName: input.targetName,
    db,
  })
  if (!plan.quota.ok) {
    throw new WorkspaceMoveError(
      'The target does not have room for this workspace. Free space at the target or pick a larger one.',
      413,
      'workspace_move_over_quota',
    )
  }
  if (plan.totals.rows === 0 && plan.totals.files === 0) {
    throw new WorkspaceMoveError('There is nothing in this selection to move.', 400, 'workspace_move_empty')
  }

  const move = await db.workspaceMove.create({
    data: {
      workspaceId: input.workspaceId,
      direction: input.direction,
      status: 'planning',
      sourceWorkspaceId: input.workspaceId,
      sourceName: workspace.name,
      targetName: plan.target.name,
      // Persisted so a resume is the same job the plan was built for — see the
      // model comment. `runMoveJob` reads these, never the caller's context.
      requesterId: input.requesterId,
      isOwner: input.isOwner,
      ownerUserId: input.requesterId,
      selection: selection as any,
      plan: plan as any,
      progress: {} as any,
      handover: buildHandover('pending', rows) as any,
    },
  })

  // The derived ids depend on the move id, so the handover state is rebuilt now
  // that the row exists.
  const handover = buildHandover(move.id, rows)
  await db.workspaceMove.update({ where: { id: move.id }, data: { handover: handover as any } })

  void kickMove(move.id, { db, instanceSize: workspace.instanceSize ?? null, requesterId: input.requesterId, isOwner: input.isOwner, selection })
  return { move: { ...move, handover }, plan }
}

/** Start (or restart) the job for a row. No-op when it is already running here. */
export function kickMove(
  moveId: string,
  ctx?: { db?: any; instanceSize?: string | null; requesterId?: string; isOwner?: boolean; selection?: MoveSelection },
): Promise<void> {
  const existing = running.get(moveId)
  if (existing) return existing
  const job = runMoveJob(moveId, ctx)
    .catch((err) => {
      console.error(`[workspace-move] ${moveId} failed:`, err?.message ?? err)
    })
    .finally(() => {
      running.delete(moveId)
    })
  running.set(moveId, job)
  return job
}

/** What a job run needs that the request that started it happened to carry. */
export interface MoveJobContext {
  requesterId: string
  isOwner: boolean
  ownerUserId: string
  instanceSize: string | null
}

/**
 * The identity a job run uses.
 *
 * The job outlives its request: it is paused and resumed from the UI, and
 * restarted by the crash sweep. Reading this from `ctx` alone meant a resume
 * fell back to `isOwner: true` — so a plan built for an admin, resumed with no
 * context, streamed a *different* row set than the one the user approved (a DM
 * the requester cannot see was excluded by the plan and included by the
 * resume) — and `ownerUserId: ''`, which could create an ownerless target.
 *
 * So the row wins. `ctx` is only a fallback for rows created before these
 * columns existed, and the last resort matches the previous behaviour.
 *
 * `instanceSize` comes from the frozen plan for the same reason: the target is
 * created by the job, and the quota the user approved was computed against that
 * size.
 */
export function moveJobContext(row: any, ctx?: {
  instanceSize?: string | null
  requesterId?: string
  isOwner?: boolean
}): MoveJobContext {
  const plan = (row?.plan ?? {}) as MovePlan
  const requesterId = row?.requesterId ?? ctx?.requesterId ?? ''
  return {
    requesterId,
    isOwner: row?.isOwner ?? ctx?.isOwner ?? true,
    ownerUserId: row?.ownerUserId ?? requesterId,
    instanceSize: plan?.target?.instanceSize ?? ctx?.instanceSize ?? null,
  }
}

async function runMoveJob(
  moveId: string,
  ctx?: { db?: any; instanceSize?: string | null; requesterId?: string; isOwner?: boolean; selection?: MoveSelection },
): Promise<void> {
  const db: any = ctx?.db ?? prisma
  const row = await db.workspaceMove.findUnique({ where: { id: moveId } })
  if (!row) return
  if (row.status === 'done' || row.status === 'cancelled' || row.status === 'failed') return

  const plan = (row.plan ?? {}) as MovePlan
  const handover = readHandover(row.handover)
  const selection = (ctx?.selection ?? (row.selection as MoveSelection)) as MoveSelection
  // Identity from the row, never the caller: a resume has no request context.
  const jobContext = moveJobContext(row, ctx)
  const { source, target } = endpointsFor(row.direction as MoveDirection, moveId, db)

  const update = async (data: Record<string, any>) => {
    await db.workspaceMove.update({ where: { id: moveId }, data })
  }
  await update({ status: 'records', error: null })

  try {
    const result = await runMove({
      moveId,
      direction: row.direction as MoveDirection,
      source,
      target,
      sourceWorkspaceId: row.sourceWorkspaceId,
      targetWorkspaceId: row.targetWorkspaceId ?? null,
      ...jobContext,
      selection,
      plan,
      progress: (row.progress ?? {}) as MoveProgress,
      handover,
      control: async () => {
        const current = await db.workspaceMove.findUnique({ where: { id: moveId }, select: { status: true } })
        if (current?.status === 'paused') return 'pause'
        if (current?.status === 'cancelled') return 'cancel'
        return 'run'
      },
      onProgress: async (patch) => {
        await update({
          ...(patch.progress ? { progress: patch.progress } : {}),
          ...(patch.targetWorkspaceId ? { targetWorkspaceId: patch.targetWorkspaceId } : {}),
          ...(patch.rowsCopied ? { rowsCopied: { increment: patch.rowsCopied } } : {}),
          ...(patch.filesCopied ? { filesCopied: { increment: patch.filesCopied } } : {}),
          ...(patch.bytesCopied ? { bytesCopied: { increment: patch.bytesCopied } } : {}),
        })
      },
      log: (line) => console.log(`[workspace-move] ${moveId} ${line}`),
    })

    if (result.stopped === 'cancel') {
      await update({ status: 'cancelled', targetWorkspaceId: result.targetWorkspaceId || null })
      return
    }
    if (result.stopped === 'pause') {
      await update({ status: 'paused', targetWorkspaceId: result.targetWorkspaceId || null })
      return
    }
    await update({ status: 'handover', targetWorkspaceId: result.targetWorkspaceId, progress: result.progress as any })
    await update({ status: 'done' })
  } catch (err: any) {
    await update({ status: 'failed', error: String(err?.message ?? err).slice(0, 2000) })
    throw err
  }
}

/**
 * The single "Switch over" action. Source first, target second — see
 * `handover.ts` for why the order is the contract.
 */
export async function switchOverMove(moveId: string, db: any = prisma): Promise<void> {
  const row = await db.workspaceMove.findUnique({ where: { id: moveId } })
  if (!row) throw new WorkspaceMoveError('Move not found', 404, 'workspace_move_not_found')
  if (row.status !== 'done') {
    throw new WorkspaceMoveError('Finish the move before switching over.', 409, 'workspace_move_not_finished')
  }
  if (!row.targetWorkspaceId) {
    throw new WorkspaceMoveError('This move has no target workspace.', 409, 'workspace_move_no_target')
  }
  const handover = readHandover(row.handover)
  const { source, target } = endpointsFor(row.direction as MoveDirection, moveId, db)
  await switchOver(
    {
      source: {
        setEnabled: (input) => source.setEnabled({ ...input, workspaceId: row.sourceWorkspaceId }),
        markMoved: (targetWorkspaceId) => source.markMoved({ workspaceId: row.sourceWorkspaceId, targetWorkspaceId }),
      },
      target: {
        setEnabled: (input) => target.setEnabled({ ...input, workspaceId: row.targetWorkspaceId }),
      },
    },
    handover,
    row.targetWorkspaceId,
  )
  await db.workspaceMove.update({ where: { id: moveId }, data: { switchedOverAt: new Date() } })
}

export async function switchBackMove(moveId: string, db: any = prisma): Promise<void> {
  const row = await db.workspaceMove.findUnique({ where: { id: moveId } })
  if (!row) throw new WorkspaceMoveError('Move not found', 404, 'workspace_move_not_found')
  if (!row.switchedOverAt) {
    throw new WorkspaceMoveError('This move was never switched over.', 409, 'workspace_move_not_switched_over')
  }
  const handover = readHandover(row.handover)
  const { source, target } = endpointsFor(row.direction as MoveDirection, moveId, db)
  await switchBack(
    {
      source: {
        setEnabled: (input) => source.setEnabled({ ...input, workspaceId: row.sourceWorkspaceId }),
        markMoved: (targetWorkspaceId) => source.markMoved({ workspaceId: row.sourceWorkspaceId, targetWorkspaceId }),
      },
      target: {
        setEnabled: (input) => target.setEnabled({ ...input, workspaceId: row.targetWorkspaceId }),
      },
    },
    handover,
  )
  await db.workspaceMove.update({ where: { id: moveId }, data: { switchedOverAt: null } })
}

export async function setMoveStatus(moveId: string, status: MoveStatus, db: any = prisma): Promise<void> {
  await db.workspaceMove.update({ where: { id: moveId }, data: { status } })
}

/** Re-derive the rows for a move (used by the serve routes). */
export async function moveRowsFor(moveId: string, db: any = prisma) {
  const row = await db.workspaceMove.findUnique({ where: { id: moveId } })
  if (!row) throw new WorkspaceMoveError('Move not found', 404, 'workspace_move_not_found')
  return collectMoveRows({
    workspaceId: row.sourceWorkspaceId,
    requesterId: '',
    isOwner: true,
    selection: row.selection as MoveSelection,
    db,
  })
}
