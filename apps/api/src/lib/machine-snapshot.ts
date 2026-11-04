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
import { DEFAULT_STALE_AFTER_MS } from '../services/chat-turn-state.service'

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
  /**
   * How the cloud copy is doing, so the cloud can show "Last synced 4m ago" and
   * the reason it is not moving without asking the desktop again (SHO-241).
   * Null when this machine was never paired (there is nothing to sync).
   */
  sync?: {
    running: boolean
    copyReady: boolean
    lastAckedAt: string | null
    lastError: string | null
    pendingChanges: number
  } | null
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

/**
 * Background-task sources that are *watches*, not processes. Their row lives in
 * the database, survives a restart and fires its `[Task update]` on the next
 * boot, so a restart interrupts nothing. Mirrors `REMOTE_SOURCES` in
 * `background-tasks.service`, which is what the runtime reports them as.
 *
 * Everything else (`shell`, `subagent`) is a child process that dies with us.
 */
const WATCH_TASK_SOURCES = ['work_item', 'agent_reply', 'project_call']

export interface LiveWorkCounts {
  /**
   * Agent runs a restart would interrupt: one per distinct run — a chat with a
   * live turn, or a team-chat reply that has been dispatched but has not opened
   * its session yet. The number the update banner and the Quit dialog print.
   */
  agentRuns: number
  /**
   * Background *processes* (a shell command, a subagent) that die with the
   * process. They are not agent runs, and they do not hold "Restart when idle":
   * SHO-141 settles them as `interrupted` and wakes the agent, which is the
   * "wake the agent later" a watch needs anyway.
   */
  backgroundCommands: number
  /** @deprecated Read `agentRuns`. Kept one release for an older desktop shell. */
  liveTurns: number
  /** @deprecated Read `agentRuns`/`backgroundCommands`. */
  runningTasks: number
  /** @deprecated Read `agentRuns`. */
  runningAgentReplies: number
}

/**
 * The freshness rule for a live turn, shared with the desktop route so the
 * number it prints and the list it shows can never disagree.
 *
 * A turn whose last heartbeat is older than `staleBefore` is dead — the same
 * threshold `chat-turn-reattach` uses to take a turn over. Without a cutoff
 * (the cloud heartbeat does not pass one) every session holding an
 * `activeTurnId` counts, which is the historical behaviour.
 */
export function liveTurnWhere(staleBefore?: Date | null): Record<string, unknown> {
  const where: Record<string, unknown> = { activeTurnId: { not: null } }
  if (!staleBefore) return where
  where.OR = [
    { activeTurnHeartbeatAt: { gte: staleBefore } },
    { AND: [{ activeTurnHeartbeatAt: null }, { activeTurnStartedAt: { gte: staleBefore } }] },
    { AND: [{ activeTurnHeartbeatAt: null }, { activeTurnStartedAt: null }] },
  ]
  return where
}

/**
 * The "is anything running on this machine" counts, defined once.
 *
 * Two readers with different needs: the cloud heartbeat (below) wants totals,
 * and the desktop's update/quit gate (SHO-181) wants to know when they hit zero
 * before it restarts — for which a turn whose heartbeat has stopped is not live.
 * Both go through here so the two can never disagree about what "running" means.
 *
 * `agentRuns` is deliberately not a sum of table counts. A team-chat reply opens
 * a chat session, so counting reply rows *and* sessions counted the same run
 * twice, and every card watch counted a third time as soon as a running
 * `BackgroundTask` row was treated as a live run (SHO-317: 19 "interrupted" runs
 * for 4 real ones).
 */
export async function countLiveWork(
  db: any = prisma,
  opts: {
    /** Treat a turn whose last heartbeat is older than this as dead. */
    staleTurnBefore?: Date | null
    /** Count team-chat replies that have not opened their session yet. */
    agentReplies?: boolean
  } = {},
): Promise<LiveWorkCounts> {
  // A reply that is still being written needs the same freshness rule: past the
  // window it is an orphan, and the boot sweep settles it rather than counting it.
  const replyFreshAfter = opts.staleTurnBefore ?? new Date(Date.now() - DEFAULT_STALE_AFTER_MS)
  const runningReplyWhere = { authorType: 'agent', agentStatus: 'running', deletedAt: null }
  const [liveTurns, runningTasks, backgroundCommands, runningAgentReplies, justDispatched] =
    await Promise.all([
      db.chatSession.count({ where: liveTurnWhere(opts.staleTurnBefore) }),
      db.backgroundTask.count({ where: { status: 'running' } }),
      db.backgroundTask.count({
        where: { status: 'running', NOT: { source: { in: WATCH_TASK_SOURCES } } },
      }),
      opts.agentReplies
        ? db.conversationMessage.count({ where: runningReplyWhere })
        : Promise.resolve(0),
      opts.agentReplies
        ? db.conversationMessage.count({
            where: {
              ...runningReplyWhere,
              // No session yet: the run is dispatched and its turn has not
              // opened, so no session row covers it.
              agentSessionId: null,
              createdAt: { gte: replyFreshAfter },
            },
          })
        : Promise.resolve(0),
    ])
  // Dedupe by run, not by row: a reply whose session is live is that session.
  return {
    agentRuns: (liveTurns ?? 0) + (justDispatched ?? 0),
    backgroundCommands: backgroundCommands ?? 0,
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

  // Imported lazily: `local-sync` pulls in the tunnel module, which imports this
  // one for the heartbeat payload. The cycle is harmless at call time and fatal
  // at module-evaluation time.
  let sync: MachineSnapshot['sync'] = null
  try {
    const { readMachineSyncStatus } = await import('./machine-sync/local-sync')
    const status = await readMachineSyncStatus()
    sync = status
      ? {
          running: status.running,
          copyReady: status.copyReady,
          lastAckedAt: status.lastAckedAt,
          lastError: status.lastError,
          pendingChanges: status.pendingChanges,
        }
      : null
  } catch {
    // No pusher on this build (or an unpaired machine): the snapshot is still
    // worth sending.
    sync = null
  }

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
      runningTurns: liveWork.agentRuns,
      runningTasks: liveWork.runningTasks,
      chats: chats ?? 0,
      lastActivityAt: overall ? overall.toISOString() : null,
    },
    sync,
    generatedAt: new Date().toISOString(),
  }
}
