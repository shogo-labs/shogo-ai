// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

const update = mock(async () => ({}))
const updateMany = mock(async () => ({ count: 1 }))
const findMany = mock(async () => [])
const findMessage = mock(async (): Promise<unknown> => null)

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: { update, updateMany, findMany },
    conversationMessage: { findFirst: findMessage },
  },
}))

const {
  clearActiveTurn,
  heartbeatTurn,
  listActiveChatTurns,
  markTurnEnded,
  markTurnStarted,
  startTurnHeartbeat,
} = await import('../chat-turn-state.service')

const CLEARED = { activeTurnId: null, activeTurnStartedAt: null, activeTurnHeartbeatAt: null }

describe('chat-turn-state service', () => {
  test('marks a turn active and returns its id', async () => {
    const turnId = await markTurnStarted('session-1', 'turn-1')

    expect(turnId).toBe('turn-1')
    expect(update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: {
        activeTurnId: 'turn-1',
        activeTurnStartedAt: expect.any(Date),
        activeTurnHeartbeatAt: expect.any(Date),
      },
    })
  })

  test('ends only the matching turn', async () => {
    await markTurnEnded('session-1', 'turn-1')

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', activeTurnId: 'turn-1' },
      data: CLEARED,
    })
  })

  test('heartbeats only the matching turn', async () => {
    await heartbeatTurn('session-1', 'turn-1')

    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'session-1', activeTurnId: 'turn-1' },
      data: { activeTurnHeartbeatAt: expect.any(Date) },
    })
  })

  test('heartbeat interval runs until stopped', async () => {
    updateMany.mockClear()
    const stop = startTurnHeartbeat('session-1', 'turn-1', 5)
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    const calls = updateMany.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(updateMany.mock.calls.length).toBe(calls)
  })

  test('clears a turn for an explicit stop within the caller scope', async () => {
    await clearActiveTurn({ id: 'session-1', contextId: 'project-1' })

    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'session-1', contextId: 'project-1' },
      data: CLEARED,
    })
  })

  test('lists fresh project and workspace chats with display metadata', async () => {
    const startedAt = new Date('2026-09-23T05:00:00.000Z')
    findMany.mockResolvedValueOnce([
      {
        id: 'session-project',
        name: null,
        inferredName: 'Build chat',
        isPrimary: false,
        activeTurnId: 'turn-project',
        activeTurnStartedAt: startedAt,
        project: { id: 'project-1', name: 'Website', hidden: false },
      },
      {
        id: 'session-workspace',
        name: 'Companion',
        inferredName: 'Workspace chat',
        isPrimary: true,
        activeTurnId: 'turn-workspace',
        activeTurnStartedAt: startedAt,
        project: null,
      },
    ] as never)

    await expect(listActiveChatTurns('workspace-1')).resolves.toEqual([
      {
        chatSessionId: 'session-project',
        turnId: 'turn-project',
        sessionName: 'Build chat',
        isPrimary: false,
        projectId: 'project-1',
        projectName: 'Website',
        projectHidden: false,
        startedAt,
      },
      {
        chatSessionId: 'session-workspace',
        turnId: 'turn-workspace',
        sessionName: 'Companion',
        isPrimary: true,
        projectId: null,
        projectName: null,
        projectHidden: false,
        startedAt,
      },
    ])
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isArchived: false,
        activeTurnHeartbeatAt: { gt: expect.any(Date) },
        OR: [{ workspaceId: 'workspace-1' }, { project: { workspaceId: 'workspace-1' } }],
      }),
      orderBy: { activeTurnStartedAt: 'desc' },
    }))
  })

  test('points a turn at the team-chat reply it is posting', async () => {
    const startedAt = new Date('2026-10-12T18:00:00.000Z')
    findMany.mockResolvedValueOnce([
      {
        id: 'session-ops',
        name: null,
        inferredName: '#ops: check the deploy',
        isPrimary: false,
        activeTurnId: 'turn-ops',
        activeTurnStartedAt: startedAt,
        project: { id: 'project-devops', name: 'Shogo DevOps', hidden: true },
      },
    ] as never)
    findMessage.mockResolvedValueOnce({
      id: 'msg-newest',
      conversationId: 'conv-ops',
      threadRootId: 'thread-1',
      conversation: { name: 'ops', slug: 'ops', kind: 'public' },
    })

    await expect(listActiveChatTurns('workspace-1')).resolves.toEqual([
      {
        chatSessionId: 'session-ops',
        turnId: 'turn-ops',
        sessionName: '#ops: check the deploy',
        isPrimary: false,
        projectId: 'project-devops',
        projectName: 'Shogo DevOps',
        projectHidden: true,
        startedAt,
        conversationId: 'conv-ops',
        threadRootId: 'thread-1',
        messageId: 'msg-newest',
        conversationName: 'ops',
        conversationKind: 'public',
      },
    ])
    expect(findMessage).toHaveBeenCalledWith({
      where: { agentSessionId: 'session-ops', authorType: 'agent', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        conversationId: true,
        threadRootId: true,
        conversation: { select: { name: true, slug: true, kind: true } },
      },
    })
  })

  test('uses a five-minute heartbeat window by default', async () => {
    const before = Date.now()
    await listActiveChatTurns('workspace-1')
    const cutoff = (findMany.mock.calls.at(-1) as any)[0].where.activeTurnHeartbeatAt.gt as Date
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50)
    expect(before - cutoff.getTime()).toBeLessThan(5 * 60 * 1000 + 1000)
  })
})
