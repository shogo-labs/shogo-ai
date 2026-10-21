// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat turn reattach — picks up chat turns whose tracking API pod went away.
 *
 * Project chats, workspace chats and background project calls persist a turn
 * by reading the runtime's stream buffer in the API pod that started it
 * (`trackUsageFromStream`), heartbeating `ChatSession.activeTurnHeartbeatAt`
 * while they do. When that pod dies or drains (a deploy hands its turns off
 * via `releaseTurnsForHandoff`), the heartbeat goes stale but the runtime
 * keeps running the turn. One replica (Redis lease) claims each stale turn
 * and replays the buffer from the start into the same assistant row, then
 * ends the turn the way the chat routes do.
 *
 * The runtime keeps a finished buffer for 30s and drops a running buffer
 * older than 30 minutes once nothing reads it, so only turns that went stale
 * recently are worth reattaching.
 */

import { randomUUID } from 'node:crypto'
import type { TrackedStreamResult } from '../routes/project-chat'
import { TURN_REATTACH_AFTER_MS } from '../services/chat-turn-state.service'

const TICK_MS = 30_000
const LEASE_KEY = 'chat-turn-reattach:leader'
const LEASE_MS = 90_000
/** Older heartbeats belong to turns whose runtime buffer is already gone. */
const MAX_HEARTBEAT_AGE_MS = 30 * 60_000
const MAX_TURN_AGE_MS = 48 * 60 * 60_000
const MAX_CLAIMS_PER_TICK = 20

const holder = randomUUID()
const reattaching = new Set<string>()

type StaleTurn = {
  id: string
  contextType: string | null
  contextId: string | null
  workspaceId: string | null
  activeTurnId: string | null
  activeTurnStartedAt: Date | null
  activeTurnHeartbeatAt: Date | null
}

type RuntimeTarget = {
  project: { id: string; workspaceId: string } | null
  fetchRuntime: (path: string) => Promise<Response>
}

export type ReattachDeps = {
  db: any
  acquireLease: () => Promise<boolean>
  track: typeof import('../routes/project-chat').trackUsageFromStream
  resolveTarget: (session: StaleTurn) => Promise<RuntimeTarget | null>
  startTurnHeartbeat: (chatSessionId: string, turnId: string) => () => void
  markTurnEnded: (chatSessionId: string, turnId: string) => Promise<void>
  dispatchNext: (chatSessionId: string) => Promise<unknown>
  getCallLink: typeof import('../lib/agent-call-store').getAgentCallSessionLink
  settleCall: typeof import('../services/agent-call.service').settleAgentCallFromTurn
  /**
   * Say the turn was interrupted, and queue its one resume. Injected so the
   * dead-runtime path is testable without a database write (SHO-121).
   */
  announceInterrupted: typeof import('../services/chat-resume.service').postInterruptedResume
  homeSessionWhere: () => Record<string, unknown> | null
  now: () => number
}

async function defaultDeps(): Promise<ReattachDeps> {
  const [{ prisma }, { getSharedRedis }, projectChat, turnState, dispatcher, callStore, agentCall, region, fetchers] =
    await Promise.all([
      import('../lib/prisma'),
      import('../lib/tunnel-redis'),
      import('../routes/project-chat'),
      import('../services/chat-turn-state.service'),
      import('../services/chat-queue-dispatcher.service'),
      import('../lib/agent-call-store'),
      import('../services/agent-call.service'),
      import('../lib/region'),
      import('../lib/chat-runtime-fetch'),
    ])
  return {
    db: prisma,
    acquireLease: async () => {
      const r = getSharedRedis()
      if (!r) return false
      try {
        if ((await r.set(LEASE_KEY, holder, 'PX', LEASE_MS, 'NX')) === 'OK') return true
        if ((await r.get(LEASE_KEY)) === holder) {
          await r.pexpire(LEASE_KEY, LEASE_MS)
          return true
        }
        return false
      } catch {
        return false
      }
    },
    track: projectChat.trackUsageFromStream,
    resolveTarget: async (session) => {
      if (session.contextType === 'project' && session.contextId) {
        const projectId = session.contextId
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
        if (!project) return null
        return {
          project: { id: projectId, workspaceId: project.workspaceId },
          fetchRuntime: (path) => fetchers.fetchFromProjectRuntime(projectId, path, { method: 'GET' }),
        }
      }
      if (session.workspaceId) {
        const workspaceId = session.workspaceId
        const { readWorkspaceSessionRuntimeArgs } = await import('../lib/workspace-runtime-args')
        const args = await readWorkspaceSessionRuntimeArgs(workspaceId, session.id)
        const billingProjectId = args.attachedProjectIds[0] ?? null
        return {
          project: billingProjectId ? { id: billingProjectId, workspaceId } : null,
          fetchRuntime: (path) =>
            fetchers.fetchFromWorkspaceRuntime(workspaceId, args.attachedProjectIds, path, { method: 'GET' }, args.extra, {
              alwaysEnabled: true,
            }),
        }
      }
      return null
    },
    startTurnHeartbeat: turnState.startTurnHeartbeat,
    markTurnEnded: turnState.markTurnEnded,
    dispatchNext: dispatcher.dispatchNext,
    getCallLink: callStore.getAgentCallSessionLink,
    settleCall: agentCall.settleAgentCallFromTurn,
    announceInterrupted: (await import('../services/chat-resume.service')).postInterruptedResume,
    homeSessionWhere: () => {
      const home = region.homeRegionWorkspaceWhere()
      return home ? { OR: [{ project: { workspace: home } }, { workspace: home }] } : null
    },
    now: () => Date.now(),
  }
}

/**
 * One sweep: when this replica holds the lease, claim each stale turn and
 * start following it. Returns the claimed session ids; the reattached trackers
 * keep running after this resolves.
 */
export async function reattachStaleTurns(depsArg?: ReattachDeps): Promise<string[]> {
  const deps = depsArg ?? (await defaultDeps())
  if (!(await deps.acquireLease())) return []

  const now = deps.now()
  const home = deps.homeSessionWhere()
  const candidates: StaleTurn[] = await deps.db.chatSession.findMany({
    where: {
      activeTurnId: { not: null },
      activeTurnHeartbeatAt: { lt: new Date(now - TURN_REATTACH_AFTER_MS), gt: new Date(now - MAX_HEARTBEAT_AGE_MS) },
      activeTurnStartedAt: { gt: new Date(now - MAX_TURN_AGE_MS) },
      ...(home ?? {}),
    },
    select: {
      id: true,
      contextType: true,
      contextId: true,
      workspaceId: true,
      activeTurnId: true,
      activeTurnStartedAt: true,
      activeTurnHeartbeatAt: true,
    },
    orderBy: { activeTurnHeartbeatAt: 'asc' },
    take: MAX_CLAIMS_PER_TICK,
  })

  const claimed: string[] = []
  for (const session of candidates) {
    if (!session.activeTurnId || !session.activeTurnStartedAt || reattaching.has(session.id)) continue
    const won = await deps.db.chatSession.updateMany({
      where: { id: session.id, activeTurnId: session.activeTurnId, activeTurnHeartbeatAt: session.activeTurnHeartbeatAt },
      data: { activeTurnHeartbeatAt: new Date(deps.now()) },
    })
    if (won.count !== 1) continue
    claimed.push(session.id)
    reattaching.add(session.id)
    void reattachTurn(session, deps)
      .catch((err) => console.warn(`[ChatTurnReattach] Reattaching ${session.id} failed:`, err?.message ?? err))
      .finally(() => reattaching.delete(session.id))
  }
  return claimed
}

async function reattachTurn(session: StaleTurn, deps: ReattachDeps): Promise<void> {
  const chatSessionId = session.id
  const turnId = session.activeTurnId!
  const startedAt = session.activeTurnStartedAt!
  const stopHeartbeat = deps.startTurnHeartbeat(chatSessionId, turnId)
  const link = await deps.getCallLink(chatSessionId).catch(() => undefined)
  let result: TrackedStreamResult | null = null
  try {
    const target = await deps.resolveTarget(session)
    if (!target) {
      // The runtime that was running this turn is gone, so its stream buffer is
      // gone with it and there is nothing left to follow. Ending the turn
      // silently is what left the user with no final message: say the turn was
      // interrupted and queue its one resume instead (SHO-121).
      console.warn(`[ChatTurnReattach] No runtime for ${chatSessionId}; announcing the interruption`)
      await deps.announceInterrupted(chatSessionId).catch((err: any) =>
        console.warn(`[ChatTurnReattach] Interruption note for ${chatSessionId} failed:`, err?.message ?? err),
      )
      return
    }
    const assistant = await deps.db.chatMessage.findFirst({
      where: { sessionId: chatSessionId, role: 'assistant', createdAt: { gte: startedAt } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, model: true },
    })
    const streamPath = (fromSeq: number) => `/agent/chat/${encodeURIComponent(chatSessionId)}/stream?fromSeq=${fromSeq}`
    const res = await target.fetchRuntime(streamPath(0)).catch(() => null)
    if (!res || res.status !== 200 || !res.body) {
      await res?.body?.cancel().catch(() => {})
      console.log(`[ChatTurnReattach] Runtime buffer for ${chatSessionId} is gone (${res?.status ?? 'unreachable'}); announcing the interruption`)
      // Same dead end as the branch above: the buffer this job exists to replay
      // is unreachable, so the turn ends without a word unless we say something.
      await deps.announceInterrupted(chatSessionId).catch((err: any) =>
        console.warn(`[ChatTurnReattach] Interruption note for ${chatSessionId} failed:`, err?.message ?? err),
      )
      return
    }
    console.log(`[ChatTurnReattach] Reattaching turn ${turnId} for ${chatSessionId}`)
    result = await deps.track(
      res.body,
      { chatSessionId, ...(assistant?.model ? { agentMode: assistant.model } : {}) },
      target.project,
      {
        chatSessionId,
        suppressCompletionPush: true,
        existingAssistantMessageId: assistant?.id ?? null,
        expectedTurnStartedAt: startedAt.getTime(),
        resume: async (fromSeq) => {
          try {
            return await target.fetchRuntime(streamPath(fromSeq))
          } catch {
            return null
          }
        },
      },
    )
  } finally {
    stopHeartbeat()
    if (link) await deps.settleCall(link, chatSessionId, result).catch(() => {})
    await deps.markTurnEnded(chatSessionId, turnId).catch(() => {})
    await Promise.resolve(deps.dispatchNext(chatSessionId)).catch((err) =>
      console.warn(`[ChatTurnReattach] Failed to dispatch queued chat ${chatSessionId}:`, err?.message ?? err),
    )
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startChatTurnReattachJob(): void {
  if (timer) return
  const tick = () => {
    reattachStaleTurns().catch((err) => console.warn('[ChatTurnReattach] Sweep failed:', err?.message ?? err))
  }
  timer = setInterval(tick, TICK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  console.log('[ChatTurnReattach] Started')
}

/** Stop sweeping and give up the lease so another replica takes over right away. */
export async function stopChatTurnReattachJob(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  try {
    const { getSharedRedis } = await import('../lib/tunnel-redis')
    const r = getSharedRedis()
    if (r && (await r.get(LEASE_KEY)) === holder) await r.del(LEASE_KEY)
  } catch {
    // The lease expires on its own.
  }
}
