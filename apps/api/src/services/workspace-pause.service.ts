// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-wide agent pause: "stop every agent lane".
 *
 * `agent_run_stop` stops one run or one thread — everything else keeps waking
 * agents: task updates, schedules, triggers, card hand-offs, team-chat tags.
 * On 2026-10-21 a person asked for a full pause and nothing could make it
 * stick (SHO-118). This is the one flag that stops automatic starts.
 *
 * Stored as `Workspace.settings.agentsPaused = { at, by, reason? }` through the
 * existing settings merge, so there is no schema change, no migration and no
 * desktop/cloud divergence. The flag stops *automatic* starts only: a person's
 * own message still runs, because a pause is not a lockout.
 *
 * Reads are cached for `CACHE_TTL_MS` because the dispatcher and the wake
 * sweeps ask on every tick; a set clears the entry so the same process sees it
 * at once. Other replicas converge within the TTL.
 */

import { prisma } from '../lib/prisma'
import { parseWorkspaceSettings } from '../lib/workspace-settings'

export interface WorkspacePause {
  /** ISO timestamp of the pause. */
  at: string
  /** Who paused: a user id, an agent ref, or null when it came from a script. */
  by: string | null
  reason?: string
}

const CACHE_TTL_MS = 2_000
const cache = new Map<string, { at: number; pause: WorkspacePause | null }>()

/** Test seam: forget cached state so each case starts from the database. */
export function resetWorkspacePauseCache(): void {
  cache.clear()
}

function parsePause(value: unknown): WorkspacePause | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const at = typeof raw.at === 'string' ? raw.at : typeof raw.at === 'number' ? new Date(raw.at).toISOString() : ''
  if (!at) return null
  return {
    at,
    by: typeof raw.by === 'string' ? raw.by : null,
    ...(typeof raw.reason === 'string' && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
  }
}

/** The pause in force for this workspace, or null. Cached for `CACHE_TTL_MS`. */
export async function readWorkspacePause(workspaceId: string): Promise<WorkspacePause | null> {
  if (!workspaceId) return null
  const cached = cache.get(workspaceId)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.pause
  let pause: WorkspacePause | null = null
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    })
    pause = parsePause(parseWorkspaceSettings(workspace?.settings)?.['agentsPaused'])
  } catch {
    // A read that fails must not stop work: the flag is a brake, not a lock.
    return cached?.pause ?? null
  }
  cache.set(workspaceId, { at: now, pause })
  return pause
}

/** True while every automatic agent start in this workspace is held. */
export async function isWorkspaceAgentsPaused(workspaceId: string): Promise<boolean> {
  return (await readWorkspacePause(workspaceId)) !== null
}

/**
 * The workspace a chat session belongs to. A project chat carries the project
 * id in `contextId` and resolves its workspace through the project.
 */
export async function workspaceIdForSession(session: {
  workspaceId?: string | null
  contextType?: string | null
  contextId?: string | null
}): Promise<string | null> {
  if (session.workspaceId) return session.workspaceId
  if (session.contextType === 'project' && session.contextId) {
    const project = await prisma.project.findUnique({
      where: { id: session.contextId },
      select: { workspaceId: true },
    })
    return project?.workspaceId ?? null
  }
  return null
}

/** Is this chat session's workspace paused? */
export async function isSessionWorkspacePaused(session: {
  workspaceId?: string | null
  contextType?: string | null
  contextId?: string | null
}): Promise<boolean> {
  const workspaceId = await workspaceIdForSession(session)
  return workspaceId ? isWorkspaceAgentsPaused(workspaceId) : false
}

/** Same, for a session id (one read of the row, then the cached flag). */
export async function isChatSessionWorkspacePaused(chatSessionId: string): Promise<boolean> {
  const session = await prisma.chatSession.findUnique({
    where: { id: chatSessionId },
    select: { workspaceId: true, contextType: true, contextId: true },
  })
  return session ? isSessionWorkspacePaused(session) : false
}

/**
 * Set or lift the pause. `null` lifts it. Returns the pause now in force.
 */
export async function setWorkspacePause(
  workspaceId: string,
  pause: WorkspacePause | null,
): Promise<WorkspacePause | null> {
  // Imported here, not at module scope: `workspace.service` pulls the region and
  // project graph, and every reader of this file (queue dispatcher, wake sweep,
  // schedule/trigger dispatch) must stay cheap to load. Only the write needs it.
  const { configureWorkspace } = await import('./workspace.service')
  await configureWorkspace(workspaceId, { settings: { agentsPaused: pause } })
  cache.set(workspaceId, { at: Date.now(), pause })
  return pause
}

/**
 * Lift the pause and hand back everything it held: the parked marker rows in the
 * chat queues, the task wakes, and the team-chat wakes a board hand-off parked.
 * Each is a kick, not a wait — the sweeps are idempotent and already run every
 * few seconds, this only saves the pause's worth of delay.
 */
export async function resumeWorkspaceAgents(workspaceId: string): Promise<void> {
  await setWorkspacePause(workspaceId, null)
  try {
    const sessions = (await prisma.chatSession.findMany({
      where: { OR: [{ workspaceId }, { project: { workspaceId } }] },
      select: { id: true },
    })) as Array<{ id: string }>
    const ids = sessions.map((session) => session.id)
    if (ids.length) {
      const { WAKE_PAUSED_MARKERS } = await import('./background-tasks.service')
      await (prisma as any).chatQueuedMessage
        .deleteMany({
          where: { sessionId: { in: ids }, kind: 'task_notification', status: 'failed', error: { in: WAKE_PAUSED_MARKERS } },
        })
        .catch(() => {})
    }
  } catch {
    // The sweeps below re-derive the same state; a failed cleanup is not fatal.
  }
  // Sequenced, not parallel: the sweep is what queues the held updates, so the
  // dispatcher has nothing to take until it has run.
  await Promise.all([
    import('./background-tasks.service')
      .then((module) => module.sweepUnnotifiedWakes())
      .catch(() => 0),
    import('./conversation-agent-dispatcher')
      .then((module) => module.sweepPendingAgentWakes(0))
      .catch(() => 0),
  ])
  await import('./chat-queue-dispatcher.service')
    .then((module) => module.dispatchPendingSessions())
    .catch(() => 0)
}
