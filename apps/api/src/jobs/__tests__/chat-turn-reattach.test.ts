// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import type { ReattachDeps } from '../chat-turn-reattach'

// The call store needs a database, and `chat-turn-state.service` builds the
// Prisma client at import time — so the test database has to exist before any
// of these are imported.
const { setupChannelsTestDb } = await import('../../__tests__/helpers/channels-test-db')
const { dir } = setupChannelsTestDb()
const { reattachStaleTurns } = await import('../chat-turn-reattach')
const agentCallStore = await import('../../lib/agent-call-store')
const { CALLEE_TURN_LOST, settleAgentCallFromTurn } = await import('../../services/agent-call.service')
const { prisma } = await import('../../lib/prisma')
const callDb = prisma as any

const NOW = Date.parse('2026-10-16T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000)

type Session = {
  id: string
  contextType: string | null
  contextId: string | null
  workspaceId: string | null
  activeTurnId: string | null
  activeTurnStartedAt: Date | null
  activeTurnHeartbeatAt: Date | null
}

function fakeDb(sessions: Session[], messages: Array<{ id: string; sessionId: string; role: string; createdAt: Date; model?: string }>) {
  const time = (d: Date | null | undefined) => (d ? d.getTime() : null)
  return {
    chatSession: {
      findMany: async ({ where }: any) =>
        sessions.filter((s) => {
          const hb = time(s.activeTurnHeartbeatAt)
          const started = time(s.activeTurnStartedAt)
          return (
            s.activeTurnId !== null &&
            hb !== null &&
            hb < where.activeTurnHeartbeatAt.lt.getTime() &&
            hb > where.activeTurnHeartbeatAt.gt.getTime() &&
            started !== null &&
            started > where.activeTurnStartedAt.gt.getTime()
          )
        }).map((s) => ({ ...s })),
      updateMany: async ({ where, data }: any) => {
        // Yield so concurrent sweeps interleave like real DB round trips.
        await Promise.resolve()
        const s = sessions.find(
          (x) => x.id === where.id && x.activeTurnId === where.activeTurnId && time(x.activeTurnHeartbeatAt) === time(where.activeTurnHeartbeatAt),
        )
        if (!s) return { count: 0 }
        Object.assign(s, data)
        return { count: 1 }
      },
    },
    chatMessage: {
      findFirst: async ({ where }: any) => {
        const rows = messages
          .filter((m) => m.sessionId === where.sessionId && m.role === where.role && m.createdAt >= where.createdAt.gte)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return rows[0] ? { id: rows[0].id, model: rows[0].model ?? null } : null
      },
    },
  }
}

function staleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'chat-1',
    contextType: 'project',
    contextId: 'proj-1',
    workspaceId: null,
    activeTurnId: 'turn-1',
    activeTurnStartedAt: minutesAgo(20),
    activeTurnHeartbeatAt: minutesAgo(4),
    ...overrides,
  }
}

function harness(sessions: Session[], opts: { streamStatus?: number; trackResult?: any; leader?: boolean } = {}) {
  const messages = [
    { id: 'old-reply', sessionId: 'chat-1', role: 'assistant', createdAt: minutesAgo(60) },
    { id: 'this-turn', sessionId: 'chat-1', role: 'assistant', createdAt: minutesAgo(19), model: 'advanced' },
  ]
  const log = {
    tracked: [] as any[],
    fetched: [] as string[],
    heartbeats: [] as string[],
    stoppedHeartbeats: 0,
    ended: [] as Array<[string, string]>,
    dispatched: [] as string[],
  }
  let finish!: () => void
  const finished = new Promise<void>((r) => { finish = r })
  const deps: ReattachDeps = {
    db: fakeDb(sessions, messages),
    acquireLease: async () => opts.leader ?? true,
    track: (async (...args: any[]) => {
      log.tracked.push(args)
      return opts.trackResult ?? { outcome: 'complete', status: 'completed', text: 'full reply', assistantMessageId: 'this-turn' }
    }) as any,
    resolveTarget: async (session) => ({
      project: session.contextId ? { id: session.contextId, workspaceId: 'ws-1' } : null,
      fetchRuntime: async (path) => {
        log.fetched.push(path)
        const status = opts.streamStatus ?? 200
        return status === 200 ? new Response('data: {}\n\n', { status }) : new Response(null, { status })
      },
    }),
    startTurnHeartbeat: (id) => {
      log.heartbeats.push(id)
      return () => { log.stoppedHeartbeats++ }
    },
    markTurnEnded: async (id, turnId) => { log.ended.push([id, turnId]) },
    dispatchNext: async (id) => {
      log.dispatched.push(id)
      finish()
    },
    getCallLink: agentCallStore.getAgentCallSessionLink,
    settleCall: settleAgentCallFromTurn,
    homeSessionWhere: () => null,
    now: () => NOW,
  }
  return { deps, log, finished }
}

beforeEach(async () => {
  await callDb.agentCall.deleteMany({})
  await callDb.agentCallSessionLink.deleteMany({})
})

afterAll(async () => {
  await callDb.agentCall.deleteMany({})
  await callDb.agentCallSessionLink.deleteMany({})
  await callDb.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('chat turn reattach', () => {
  it('replays a stale turn into the assistant row that turn already wrote, then ends it', async () => {
    const sessions = [staleSession()]
    const { deps, log, finished } = harness(sessions)
    expect(await reattachStaleTurns(deps)).toEqual(['chat-1'])
    await finished

    expect(log.fetched[0]).toBe('/agent/chat/chat-1/stream?fromSeq=0')
    expect(log.tracked).toHaveLength(1)
    const [, body, project, options] = log.tracked[0]
    expect(body).toEqual({ chatSessionId: 'chat-1', agentMode: 'advanced' })
    expect(project).toEqual({ id: 'proj-1', workspaceId: 'ws-1' })
    expect(options).toMatchObject({
      chatSessionId: 'chat-1',
      existingAssistantMessageId: 'this-turn',
      expectedTurnStartedAt: minutesAgo(20).getTime(),
      suppressCompletionPush: true,
    })
    expect(log.heartbeats).toEqual(['chat-1'])
    expect(log.stoppedHeartbeats).toBe(1)
    expect(log.ended).toEqual([['chat-1', 'turn-1']])
    expect(log.dispatched).toEqual(['chat-1'])
    // The claim refreshed the heartbeat, so the next sweep leaves it alone.
    expect(sessions[0].activeTurnHeartbeatAt!.getTime()).toBe(NOW)
  })

  it('leaves turns with a fresh heartbeat, and turns whose buffer is long gone, alone', async () => {
    const sessions = [
      staleSession({ id: 'fresh', activeTurnHeartbeatAt: minutesAgo(1) }),
      staleSession({ id: 'ancient', activeTurnHeartbeatAt: minutesAgo(45) }),
      staleSession({ id: 'idle', activeTurnId: null }),
    ]
    const { deps, log } = harness(sessions)
    expect(await reattachStaleTurns(deps)).toEqual([])
    expect(log.tracked).toHaveLength(0)
  })

  it('does nothing without the lease', async () => {
    const { deps, log } = harness([staleSession()], { leader: false })
    expect(await reattachStaleTurns(deps)).toEqual([])
    expect(log.tracked).toHaveLength(0)
  })

  it('claims a turn once when two replicas sweep at the same time, so it is tracked and billed once', async () => {
    const sessions = [staleSession()]
    const a = harness(sessions)
    const b = harness(sessions)
    const [claimedA, claimedB] = await Promise.all([reattachStaleTurns(a.deps), reattachStaleTurns(b.deps)])
    expect([...claimedA, ...claimedB]).toEqual(['chat-1'])
    await (claimedA.length ? a.finished : b.finished)
    expect(a.log.tracked.length + b.log.tracked.length).toBe(1)
  })

  it('ends the turn when the runtime buffer is gone, and fails its project call with callee_turn_lost', async () => {
    await agentCallStore.putAgentCall('proj-1', { status: 'running', runId: 'run-1', startedAt: 1, updatedAt: 1 })
    await agentCallStore.linkAgentCallSession('chat-1', { projectId: 'proj-1', runId: 'run-1', startedAt: 1 })
    const { deps, log, finished } = harness([staleSession()], { streamStatus: 204 })
    await reattachStaleTurns(deps)
    await finished

    expect(log.tracked).toHaveLength(0)
    expect(log.ended).toEqual([['chat-1', 'turn-1']])
    expect(await agentCallStore.getAgentCall('proj-1', 'run-1')).toMatchObject({
      status: 'failed',
      chatSessionId: 'chat-1',
      error: { code: CALLEE_TURN_LOST },
    })
  })

  it('completes a project call with the replayed reply', async () => {
    await agentCallStore.putAgentCall('proj-1', { status: 'running', runId: 'run-2', startedAt: 1, updatedAt: 1 })
    await agentCallStore.linkAgentCallSession('chat-1', { projectId: 'proj-1', runId: 'run-2', startedAt: 1 })
    const { deps, finished } = harness([staleSession()])
    await reattachStaleTurns(deps)
    await finished
    expect(await agentCallStore.getAgentCall('proj-1', 'run-2')).toMatchObject({ status: 'completed', reply: 'full reply' })
  })

  it('fails a project call whose replay ended partway', async () => {
    await agentCallStore.putAgentCall('proj-1', { status: 'running', runId: 'run-3', startedAt: 1, updatedAt: 1 })
    await agentCallStore.linkAgentCallSession('chat-1', { projectId: 'proj-1', runId: 'run-3', startedAt: 1 })
    const { deps, finished } = harness([staleSession()], {
      trackResult: { outcome: 'partial', status: null, text: 'some of it', assistantMessageId: 'this-turn' },
    })
    await reattachStaleTurns(deps)
    await finished
    expect(await agentCallStore.getAgentCall('proj-1', 'run-3')).toMatchObject({
      status: 'failed',
      reply: 'some of it',
      error: { code: CALLEE_TURN_LOST },
    })
  })
})
