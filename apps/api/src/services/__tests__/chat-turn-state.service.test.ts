// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

const update = mock(async () => ({}))
const updateMany = mock(async () => ({ count: 1 }))
const findMany = mock(async () => [])

mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: { update, updateMany, findMany },
  },
}))

const {
  clearActiveTurn,
  listActiveChatTurns,
  markTurnEnded,
  markTurnStarted,
} = await import('../chat-turn-state.service')

describe('chat-turn-state service', () => {
  test('marks a turn active and returns its id', async () => {
    const turnId = await markTurnStarted('session-1', 'turn-1')

    expect(turnId).toBe('turn-1')
    expect(update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { activeTurnId: 'turn-1', activeTurnStartedAt: expect.any(Date) },
    })
  })

  test('ends only the matching turn', async () => {
    await markTurnEnded('session-1', 'turn-1')

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', activeTurnId: 'turn-1' },
      data: { activeTurnId: null, activeTurnStartedAt: null },
    })
  })

  test('clears a turn for an explicit stop', async () => {
    await clearActiveTurn('session-1')

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { activeTurnId: null, activeTurnStartedAt: null },
    })
  })

  test('lists fresh project and workspace chats with display metadata', async () => {
    const startedAt = new Date('2026-09-23T05:00:00.000Z')
    findMany.mockResolvedValueOnce([
      {
        id: 'session-project',
        name: null,
        inferredName: 'Build chat',
        activeTurnId: 'turn-project',
        activeTurnStartedAt: startedAt,
        project: { id: 'project-1', name: 'Website', hidden: false },
      },
      {
        id: 'session-workspace',
        name: 'Companion',
        inferredName: 'Workspace chat',
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
        projectId: 'project-1',
        projectName: 'Website',
        projectHidden: false,
        startedAt,
      },
      {
        chatSessionId: 'session-workspace',
        turnId: 'turn-workspace',
        sessionName: 'Companion',
        projectId: null,
        projectName: null,
        projectHidden: false,
        startedAt,
      },
    ])
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isArchived: false,
        activeTurnStartedAt: expect.objectContaining({ not: null, gt: expect.any(Date) }),
        OR: [{ workspaceId: 'workspace-1' }, { project: { workspaceId: 'workspace-1' } }],
      }),
      orderBy: { activeTurnStartedAt: 'desc' },
    }))
  })
})

