// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace hosted on a paired desktop (SHO-285, the metal model).
 *
 * `Workspace.hostInstanceId` names the desktop. Such a workspace is a normal
 * workspace in every way that touches data: the same id on both sides, rows in
 * both databases (synced both ways by `machine-sync/`), every route reads and
 * writes it, every member check applies. Only its compute is elsewhere:
 *
 *   • **Agent turns** resolve to the desktop's runtime through the instance
 *     tunnel (`resolveWorkspaceRuntimeUrl` / `resolveProjectPodUrl`, the
 *     host-tunnel branch next to metal).
 *   • **Background work** — schedules, heartbeats, triggers, wakes, digests,
 *     queued messages — runs on the desktop. Every cloud worker narrows its
 *     query with `CLOUD_COMPUTE_ONLY` / `notHostedWorkspaceWhere()`, and that one
 *     where-clause is the whole guard. There are no write guards: a cloud write
 *     lands in Postgres and syncs down.
 */

import { prisma } from './prisma'

/** Prisma `where` fragment selecting workspaces whose compute is the cloud's. */
export const CLOUD_COMPUTE_ONLY = { hostInstanceId: null } as const

/** Prisma `where` fragment selecting workspaces hosted on a desktop. */
export const HOSTED_ONLY = { hostInstanceId: { not: null } } as const

export function isHostedWorkspace(
  workspace: { hostInstanceId?: string | null } | null | undefined,
): boolean {
  return Boolean(workspace?.hostInstanceId)
}

/** The host of a workspace, or null for cloud compute. */
export async function hostInstanceIdOf(workspaceId: string): Promise<string | null> {
  if (!workspaceId) return null
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { hostInstanceId: true },
  })
  return workspace?.hostInstanceId ?? null
}

/** Merge `{ hostInstanceId: null }` into a workspace `where`. */
export function withCloudCompute<T extends Record<string, unknown>>(where: T): T & {
  hostInstanceId: null
} {
  return { ...where, ...CLOUD_COMPUTE_ONLY }
}

/**
 * How long a pod reuses the hosted-id set. Background workers read it on every
 * tick of several loops (PERF-7); the set changes only when a desktop pairs a
 * workspace, and the pod that ingests that batch drops its cache at once.
 */
const HOSTED_IDS_TTL_MS = Math.max(
  0,
  Number(process.env.SHOGO_HOSTED_WORKSPACE_IDS_TTL_MS ?? process.env.SHOGO_MACHINE_WORKSPACE_IDS_TTL_MS ?? 30_000) || 0,
)

let cachedIds: { ids: string[]; at: number } | null = null
let inflight: Promise<string[]> | null = null
let generation = 0

export function invalidateHostedWorkspaceIds(): void {
  cachedIds = null
  inflight = null
  generation++
}

/** Ids of every hosted workspace, cached per pod; concurrent callers share one read. */
export async function hostedWorkspaceIds(): Promise<string[]> {
  if (cachedIds && Date.now() - cachedIds.at < HOSTED_IDS_TTL_MS) return cachedIds.ids
  if (inflight) return inflight
  const startedGeneration = generation
  const read = prisma.workspace
    .findMany({ where: HOSTED_ONLY, select: { id: true } })
    .then((rows: Array<{ id: string }>) => {
      const ids = rows.map((row) => row.id)
      if (startedGeneration === generation) cachedIds = { ids, at: Date.now() }
      return ids
    })
    .finally(() => {
      if (inflight === read) inflight = null
    })
  inflight = read
  return read
}

/** `{ workspaceId: { notIn: … } }`, or nothing when no desktop hosts anything. */
export async function notHostedWorkspaceWhere(): Promise<Record<string, unknown>> {
  const ids = await hostedWorkspaceIds()
  return ids.length ? { workspaceId: { notIn: ids } } : {}
}

/**
 * The same exclusion for a `ChatSession`, which reaches its workspace directly
 * (`workspaceId`) or through its project (`contextId`, project chats).
 */
export function hostedSessionExclusion(workspaceIds: string[]): Record<string, unknown> {
  if (!workspaceIds.length) return {}
  return {
    AND: [
      { OR: [{ workspaceId: null }, { workspaceId: { notIn: workspaceIds } }] },
      { OR: [{ contextType: { not: 'project' } }, { project: { workspaceId: { notIn: workspaceIds } } }] },
    ],
  }
}

/** Whether this session's background work (resume notes, queue drain) belongs to a desktop. */
export async function isHostedWorkspaceSession(
  session: { workspaceId?: string | null; contextType?: string | null; contextId?: string | null } | null,
): Promise<boolean> {
  if (!session) return false
  const ids = await hostedWorkspaceIds()
  if (!ids.length) return false
  const own = session.workspaceId ?? null
  if (own && ids.includes(own)) return true
  if (session.contextType === 'project' && session.contextId) {
    const project = await prisma.project.findUnique({
      where: { id: session.contextId },
      select: { workspaceId: true },
    })
    return Boolean(project?.workspaceId && ids.includes(project.workspaceId))
  }
  return false
}

/**
 * The instance rows that host a workspace — the device key the desktop pushes
 * under. `GET /machines` and `GET /instances?scope=owner` pick the
 * representative row of a machine from this set so both lists name the same id
 * (SHO-241).
 */
export async function hostingInstanceIds(instanceIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(instanceIds.filter(Boolean))]
  if (!ids.length) return new Set()
  try {
    const rows = (await prisma.workspace.findMany({
      where: { hostInstanceId: { in: ids } },
      select: { hostInstanceId: true },
      distinct: ['hostInstanceId'],
    })) as Array<{ hostInstanceId: string | null }>
    return new Set(rows.map((row) => row.hostInstanceId).filter(Boolean) as string[])
  } catch {
    return new Set()
  }
}
