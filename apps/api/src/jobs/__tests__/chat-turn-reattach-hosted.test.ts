// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A hosted workspace's turn is the cloud's to recover only when the cloud was
 * the one following it (SHO-546).
 *
 * SHO-276 excluded every `hostInstanceId` workspace from the reattach sweep,
 * which is right for a turn started on the desktop and mirrored up — the desktop
 * writes that row. It is wrong for a turn the cloud API started and relays
 * through the host tunnel: when the relay dies, nothing re-attaches and the chat
 * stays stuck forever.
 *
 * The two are told apart by the write-ahead journal the relay fills
 * (`chat_turn_frames`): a turn with frames here was relayed by this side, and a
 * desktop-started turn has none because that table is not mirrored.
 *
 * Run: bun test apps/api/src/jobs/__tests__/chat-turn-reattach-hosted.test.ts
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { ReattachDeps } from '../chat-turn-reattach'

const { reattachStaleTurns } = await import('../chat-turn-reattach')

const NOW = Date.parse('2026-11-23T08:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000)
const HOSTED_WS = 'ws-hosted'
const CLOUD_WS = 'ws-cloud'

type Session = {
  id: string
  contextType: string | null
  contextId: string | null
  workspaceId: string | null
  activeTurnId: string | null
  activeTurnStartedAt: Date | null
  activeTurnHeartbeatAt: Date | null
}

function session(overrides: Partial<Session>): Session {
  return {
    id: 'chat',
    contextType: 'workspace',
    contextId: null,
    workspaceId: CLOUD_WS,
    activeTurnId: 'turn',
    activeTurnStartedAt: minutesAgo(20),
    activeTurnHeartbeatAt: minutesAgo(4),
    ...overrides,
  }
}

/** Enough Prisma semantics for both sweeps' `where` clauses. */
function fakeDb(sessions: Session[], hostedWorkspaceIds: string[]) {
  const time = (d: Date | null | undefined) => (d ? d.getTime() : null)
  const inHosted = (s: Session) => !!s.workspaceId && hostedWorkspaceIds.includes(s.workspaceId)
  const matchesShape = (s: Session, where: any) =>
    s.activeTurnId !== null &&
    time(s.activeTurnHeartbeatAt) !== null &&
    time(s.activeTurnHeartbeatAt)! < where.activeTurnHeartbeatAt.lt.getTime() &&
    time(s.activeTurnHeartbeatAt)! > where.activeTurnHeartbeatAt.gt.getTime() &&
    time(s.activeTurnStartedAt) !== null &&
    time(s.activeTurnStartedAt)! > where.activeTurnStartedAt.gt.getTime()

  return {
    workspace: {
      findMany: async () => hostedWorkspaceIds.map((id) => ({ id })),
    },
    chatSession: {
      findMany: async ({ where }: any) => {
        // Both sweeps put their workspace filter in `AND[0]`: the exclusion has
        // `notIn`, the inclusion has `in`.
        const andClauses: any[] = Array.isArray(where.AND) ? where.AND : []
        const inclusion = andClauses.find((clause) => clause?.OR?.some?.((c: any) => c.workspaceId?.in))
        const exclusion = andClauses.find((clause) => clause?.OR?.some?.((c: any) => c.workspaceId?.notIn))
        return sessions
          .filter((s) => {
            if (!matchesShape(s, where)) return false
            if (inclusion) return inHosted(s)
            if (exclusion) return !inHosted(s)
            return true
          })
          .map((s) => ({ ...s }))
      },
      updateMany: async ({ where }: any) => {
        const s = sessions.find((x) => x.id === where.id && x.activeTurnId === where.activeTurnId)
        return { count: s ? 1 : 0 }
      },
    },
    chatMessage: { findFirst: async () => null },
  }
}

function harness(
  sessions: Session[],
  opts: { hostedWorkspaceIds?: string[]; cloudTracked?: string[] } = {},
) {
  const log = { claimed: [] as string[], fetched: [] as string[] }
  const hostedWorkspaceIds = opts.hostedWorkspaceIds ?? [HOSTED_WS]
  const cloudTracked = new Set(opts.cloudTracked ?? [])
  const deps: ReattachDeps = {
    db: fakeDb(sessions, hostedWorkspaceIds),
    acquireLease: async () => true,
    track: (async (...args: any[]) => {
      log.claimed.push(args[3]?.chatSessionId ?? 'unknown')
      return { outcome: 'complete', status: 'completed', text: 'recovered reply', assistantMessageId: 'msg-1' }
    }) as any,
    // A hosted workspace resolves to its desktop's runtime through the host
    // tunnel; the sweep only needs to reach it through this same seam.
    resolveTarget: async (s) => {
      log.fetched.push(s.id)
      return {
        project: null,
        fetchRuntime: async (path) => {
          log.fetched.push(`${s.id}:${path}`)
          return new Response('data: {"type":"data-turn-complete"}\n\n', { status: 200 })
        },
      }
    },
    startTurnHeartbeat: () => () => {},
    markTurnEnded: async () => {},
    dispatchNext: async () => undefined,
    getCallLink: async () => undefined,
    settleCall: async () => undefined,
    announceInterrupted: async () => ({ noted: false, queued: false }),
    homeSessionWhere: () => null,
    now: () => NOW,
    cloudTrackedTurns: async (turnIds) => new Set(turnIds.filter((id) => cloudTracked.has(id))),
  }
  return { deps, log }
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

describe('reattach — hosted workspace turns (SHO-546)', () => {
  beforeEach(() => {})

  it('claims a hosted turn the cloud relay journalled and replays its buffer', async () => {
    const sessions = [
      session({ id: 'chat-hosted-cloud', workspaceId: HOSTED_WS, activeTurnId: 'turn-cloud-tracked' }),
    ]
    const { deps, log } = harness(sessions, { cloudTracked: ['turn-cloud-tracked'] })
    const claimed = await reattachStaleTurns(deps)
    await settle()

    expect(claimed).toEqual(['chat-hosted-cloud'])
    expect(log.claimed).toEqual(['chat-hosted-cloud'])
    // Re-attached through the runtime seam — the host tunnel for a real hosted
    // workspace — not announced as interrupted.
    expect(log.fetched[1]).toBe('chat-hosted-cloud:/agent/chat/chat-hosted-cloud/stream?fromSeq=0')
  })

  it('still skips a mirrored desktop turn, which has no frames on this side', async () => {
    const sessions = [
      session({ id: 'chat-hosted-mirrored', workspaceId: HOSTED_WS, activeTurnId: 'turn-desktop-only' }),
    ]
    const { deps, log } = harness(sessions, { cloudTracked: [] })
    const claimed = await reattachStaleTurns(deps)
    await settle()

    expect(claimed).toEqual([])
    expect(log.claimed).toEqual([])
    expect(log.fetched).toEqual([])
  })

  it('keeps recovering cloud workspaces beside the hosted ones', async () => {
    const sessions = [
      session({ id: 'chat-cloud', workspaceId: CLOUD_WS, activeTurnId: 'turn-cloud' }),
      session({ id: 'chat-hosted-mirrored', workspaceId: HOSTED_WS, activeTurnId: 'turn-desktop-only' }),
      session({ id: 'chat-hosted-cloud', workspaceId: HOSTED_WS, activeTurnId: 'turn-hosted-cloud' }),
    ]
    const { deps, log } = harness(sessions, { cloudTracked: ['turn-hosted-cloud'] })
    const claimed = await reattachStaleTurns(deps)
    await settle()

    expect(claimed.sort()).toEqual(['chat-cloud', 'chat-hosted-cloud'])
    expect(log.claimed.sort()).toEqual(['chat-cloud', 'chat-hosted-cloud'])
  })

  it('claims nothing from a hosted workspace when no turn was journalled here', async () => {
    const sessions = [
      session({ id: 'chat-hosted-a', workspaceId: HOSTED_WS, activeTurnId: 'turn-a' }),
      session({ id: 'chat-hosted-b', workspaceId: HOSTED_WS, activeTurnId: 'turn-b' }),
    ]
    const { deps, log } = harness(sessions, { cloudTracked: [] })
    expect(await reattachStaleTurns(deps)).toEqual([])
    await settle()
    expect(log.fetched).toEqual([])
  })
})
