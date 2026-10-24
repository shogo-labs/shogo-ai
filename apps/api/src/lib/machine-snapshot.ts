// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The owner-gated picture of *this* machine: its workspaces and what is
 * running in them.
 *
 * Ids, names and counts only — never transcripts or project contents — so
 * the snapshot can ride along on every tunnel heartbeat and the cloud can
 * still render the machine's workspace list (and say "last seen 4 min ago")
 * while the desktop is offline.
 */

import { hostname as osHostname, platform, arch as osArch } from 'os'
import { prisma } from './prisma'

export interface MachineWorkspaceSummary {
  id: string
  name: string
  kind: string
  projectCount: number
  lastActivityAt: string | null
}

export interface MachineActivity {
  runningTurns: number
  runningTasks: number
  chats: number
  lastActivityAt: string | null
}

export interface MachineSnapshot {
  machine: {
    /** Device id minted at cloud-login; null when this machine was never paired. */
    id: string | null
    name: string
    hostname: string
    os: string
    arch: string
  }
  workspaces: MachineWorkspaceSummary[]
  activity: MachineActivity
  generatedAt: string
}

async function readDeviceId(db: any): Promise<string | null> {
  try {
    const row = await db.localConfig.findUnique({ where: { key: 'SHOGO_KEY_INFO' } })
    if (!row?.value) return null
    const info = JSON.parse(row.value) as { deviceId?: string }
    return info?.deviceId ?? null
  } catch {
    return null
  }
}

export interface LiveWorkCounts {
  /** Open agent turns — one per chat with a turn in flight. */
  liveTurns: number
  /** Background tasks still running. */
  runningTasks: number
  /** Team-chat agent replies that have not finished. */
  runningAgentReplies: number
}

/**
 * The "is anything running on this machine" counts, defined once.
 *
 * Two readers with different needs: the cloud heartbeat (below) wants totals,
 * and the desktop's update/quit gate (SHO-181) wants to know when they hit zero
 * before it restarts — for which a turn whose heartbeat has stopped is not live.
 * Both go through here so the two can never disagree about what "running" means.
 */
export async function countLiveWork(
  db: any = prisma,
  opts: {
    /** Treat a turn whose last heartbeat is older than this as dead. */
    staleTurnBefore?: Date | null
    /** Skip the team-chat count (the heartbeat does not need it). */
    agentReplies?: boolean
  } = {},
): Promise<LiveWorkCounts> {
  const turnWhere: Record<string, unknown> = { activeTurnId: { not: null } }
  if (opts.staleTurnBefore) {
    const stale = opts.staleTurnBefore
    turnWhere.OR = [
      { activeTurnHeartbeatAt: { gte: stale } },
      { AND: [{ activeTurnHeartbeatAt: null }, { activeTurnStartedAt: { gte: stale } }] },
      { AND: [{ activeTurnHeartbeatAt: null }, { activeTurnStartedAt: null }] },
    ]
  }
  const [liveTurns, runningTasks, runningAgentReplies] = await Promise.all([
    db.chatSession.count({ where: turnWhere }),
    db.backgroundTask.count({ where: { status: 'running' } }),
    opts.agentReplies
      ? db.conversationMessage.count({ where: { authorType: 'agent', agentStatus: 'running', deletedAt: null } })
      : Promise.resolve(0),
  ])
  return {
    liveTurns: liveTurns ?? 0,
    runningTasks: runningTasks ?? 0,
    runningAgentReplies: runningAgentReplies ?? 0,
  }
}

function latest(...dates: (Date | string | null | undefined)[]): Date | null {
  let max: Date | null = null
  for (const value of dates) {
    if (!value) continue
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) continue
    if (!max || d > max) max = d
  }
  return max
}

export async function collectMachineSnapshot(): Promise<MachineSnapshot> {
  const db = prisma as any

  const [workspaces, deviceId, projectStats, chatStats, liveWork, chats] =
    await Promise.all([
      db.workspace.findMany({ select: { id: true, name: true, kind: true } }),
      readDeviceId(db),
      db.project.groupBy({
        by: ['workspaceId'],
        where: { hidden: false },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      db.chatSession.groupBy({
        by: ['workspaceId'],
        _max: { lastActiveAt: true },
      }),
      countLiveWork(db),
      db.chatSession.count(),
    ])

  const projectsByWorkspace = new Map<string, { count: number; updatedAt: Date | null }>()
  for (const row of projectStats ?? []) {
    projectsByWorkspace.set(row.workspaceId, {
      count: row._count?._all ?? 0,
      updatedAt: row._max?.updatedAt ?? null,
    })
  }
  const chatsByWorkspace = new Map<string, Date | null>()
  for (const row of chatStats ?? []) {
    if (row.workspaceId) chatsByWorkspace.set(row.workspaceId, row._max?.lastActiveAt ?? null)
  }

  const summaries: MachineWorkspaceSummary[] = (workspaces ?? []).map((ws: any) => {
    const projects = projectsByWorkspace.get(ws.id)
    const lastActivity = latest(projects?.updatedAt, chatsByWorkspace.get(ws.id) ?? null)
    return {
      id: ws.id,
      name: ws.name,
      kind: ws.kind,
      projectCount: projects?.count ?? 0,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    }
  })
  summaries.sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0
    return bt - at
  })

  const overall = latest(...summaries.map((ws) => ws.lastActivityAt))

  return {
    machine: {
      id: deviceId,
      name: process.env.SHOGO_INSTANCE_NAME || osHostname(),
      hostname: osHostname(),
      os: platform(),
      arch: osArch(),
    },
    workspaces: summaries,
    activity: {
      runningTurns: liveWork.liveTurns,
      runningTasks: liveWork.runningTasks,
      chats: chats ?? 0,
      lastActivityAt: overall ? overall.toISOString() : null,
    },
    generatedAt: new Date().toISOString(),
  }
}
