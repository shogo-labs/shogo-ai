// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const update = mock(async () => ({}))
const updateMany = mock(async () => ({ count: 1 }))
const findMany = mock(async () => [])
const findUnique = mock(async (): Promise<unknown> => null)
const findMessage = mock(async (): Promise<unknown> => null)
const findCards = mock(async (): Promise<unknown[]> => [])
const findProfile = mock(async (): Promise<unknown> => null)
const findMember = mock(async (): Promise<unknown> => null)
mock.module('../../lib/prisma', () => ({
  prisma: {
    chatSession: { update, updateMany, findMany, findUnique },
    // `isSessionIdle` reads the queue for a live claim before it reads the turn
    // marker, and a turn-end hands the session on through it (SHO-341).
    chatQueuedMessage: { findFirst: async () => null, findMany: async () => [] },
    conversationMessage: { findFirst: findMessage },
    // The card a reply's thread belongs to, the workspace agent's name and the
    // viewer's role: one query each, whatever the number of live runs (SHO-425).
    workItem: { findMany: findCards, findFirst: async () => null },
    workspaceAgentProfile: { findUnique: findProfile },
    member: { findFirst: findMember },
  },
}))

type Published = { workspaceId: string; event: Record<string, unknown>; audience: string[] | null }
const published: Published[] = []
mock.module('../../lib/conversation-bus', () => ({
  publishConversationEvent: (workspaceId: string, event: Record<string, unknown>, audience: string[] | null = null) => {
    published.push({ workspaceId, event, audience })
  },
}))

const {
  clearActiveTurn,
  flushLiveSnapshots,
  heartbeatTurn,
  listActiveChatTurns,
  markTurnEnded,
  markTurnStarted,
  registerTurnSnapshotFlusher,
  releaseTurnsForHandoff,
  RUNNING_NOW_WINDOW_MS,
  startTurnHeartbeat,
  sweepDeadTurnsOnLocalBoot,
  TURN_REATTACH_AFTER_MS,
} = await import('../chat-turn-state.service')

const CLEARED = { activeTurnId: null, activeTurnStartedAt: null, activeTurnHeartbeatAt: null }

// The join mocks are shared by every listing test; only their calls matter.
beforeEach(() => {
  findCards.mockClear()
  findProfile.mockClear()
  findMember.mockClear()
})

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
    findProfile.mockResolvedValueOnce({ name: 'Shogo' })
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
        agentName: 'Website',
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
        agentName: 'Shogo',
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
        agentName: 'Shogo DevOps',
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

  test('names the card and the agent on every run, in one card query however many runs', async () => {
    const startedAt = new Date('2026-10-12T18:00:00.000Z')
    findMany.mockResolvedValueOnce([
      { id: 'session-a', name: null, inferredName: '#shogo-dev: @agent fix it', isPrimary: false, activeTurnId: 'turn-a', activeTurnStartedAt: startedAt, project: { id: 'proj-dev2', name: 'Shogo Dev 2', hidden: false } },
      { id: 'session-b', name: null, inferredName: '#shogo-dev: @agent plan it', isPrimary: false, activeTurnId: 'turn-b', activeTurnStartedAt: startedAt, project: { id: 'proj-dev1', name: 'Shogo Dev 1', hidden: false } },
      { id: 'session-c', name: null, inferredName: '#shogo-dev: @agent review it', isPrimary: false, activeTurnId: 'turn-c', activeTurnStartedAt: startedAt, project: { id: 'proj-dev2', name: 'Shogo Dev 2', hidden: false } },
    ] as never)
    findMessage
      .mockResolvedValueOnce({ id: 'msg-a', conversationId: 'conv-1', threadRootId: 'thread-card', conversation: { name: 'shogo-dev', slug: 'shogo-dev', kind: 'public' } })
      .mockResolvedValueOnce({ id: 'msg-b', conversationId: 'conv-1', threadRootId: 'thread-chat', conversation: { name: 'shogo-dev', slug: 'shogo-dev', kind: 'public' } })
      .mockResolvedValueOnce({ id: 'msg-c', conversationId: 'conv-1', threadRootId: 'thread-card', conversation: { name: 'shogo-dev', slug: 'shogo-dev', kind: 'public' } })
    findCards.mockResolvedValueOnce([
      { threadRootMessageId: 'thread-card', key: 'SHO-421', title: 'A full PR from an empty channel' },
      { threadRootMessageId: 'thread-chat', key: 'SHO-420', title: 'A metal VM that reports busy' },
    ])

    const chats = await listActiveChatTurns('workspace-1', { viewerUserId: 'user-1' })

    // Two runs of Shogo Dev 2 are told apart by their cards, not by their label.
    expect(chats.map((chat) => [chat.agentName, chat.card?.key])).toEqual([
      ['Shogo Dev 2', 'SHO-421'],
      ['Shogo Dev 1', 'SHO-420'],
      ['Shogo Dev 2', 'SHO-421'],
    ])
    // One query for every card behind every live reply, not one per row.
    expect(findCards).toHaveBeenCalledTimes(1)
    expect(findCards).toHaveBeenCalledWith(expect.objectContaining({
      where: { threadRootMessageId: { in: ['thread-card', 'thread-chat'] } },
    }))
    expect(findMember).toHaveBeenCalledTimes(1)
  })

  test('a viewer is told not to stop a run; a member is not told anything extra', async () => {
    const startedAt = new Date('2026-10-12T18:00:00.000Z')
    findMany.mockResolvedValue([
      { id: 'session-a', name: null, inferredName: 'Chat', isPrimary: false, activeTurnId: 'turn-a', activeTurnStartedAt: startedAt, project: { id: 'proj-dev2', name: 'Shogo Dev 2', hidden: false } },
    ] as never)
    findMember.mockResolvedValueOnce({ role: 'viewer' })
    const viewer = await listActiveChatTurns('workspace-1', { viewerUserId: 'user-1' })
    expect(viewer[0].canStop).toBe(false)

    findMember.mockResolvedValueOnce({ role: 'member' })
    const member = await listActiveChatTurns('workspace-1', { viewerUserId: 'user-2' })
    expect(member[0].canStop).toBe(true)

    // Nobody asked on behalf of a viewer: nothing to decide, nothing to send.
    findMember.mockClear()
    const internal = await listActiveChatTurns('workspace-1')
    expect(internal[0].canStop).toBeUndefined()
    expect(findMember).not.toHaveBeenCalled()
    findMany.mockResolvedValue([] as never)
  })

  test('reports a turn as running only while it is still beating', async () => {
    // SHO-494: a queued turn on a paired computer can settle its stream and
    // still leave the session marked, on both sides, for minutes. A screen must
    // not keep "Running now" for a reply that already landed, so the listing
    // asks for a recent beat rather than for a set id — and that window is far
    // shorter than the "the process is gone" one, which gates recovery.
    const before = Date.now()
    await listActiveChatTurns('workspace-1')
    const cutoff = (findMany.mock.calls.at(-1) as any)[0].where.activeTurnHeartbeatAt.gt as Date
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(RUNNING_NOW_WINDOW_MS - 50)
    expect(before - cutoff.getTime()).toBeLessThan(RUNNING_NOW_WINDOW_MS + 1000)
    expect(RUNNING_NOW_WINDOW_MS).toBeLessThan(TURN_REATTACH_AFTER_MS)
    expect(TURN_REATTACH_AFTER_MS).toBeLessThan(5 * 60 * 1000)
  })

  test('hands heartbeating turns to the reattach job on shutdown and stops heartbeating them', async () => {
    const stop = startTurnHeartbeat('session-h', 'turn-h', 60_000)
    updateMany.mockClear()
    const before = Date.now()
    expect(await releaseTurnsForHandoff()).toBe(1)

    const call = (updateMany.mock.calls.at(-1) as any)[0]
    expect(call.where).toEqual({ id: 'session-h', activeTurnId: 'turn-h' })
    expect(before - call.data.activeTurnHeartbeatAt.getTime()).toBeGreaterThan(TURN_REATTACH_AFTER_MS)
    // Already released: a second shutdown pass has nothing left to hand off.
    expect(await releaseTurnsForHandoff()).toBe(0)
    stop()
  })

  test('a stopped heartbeat is not handed off', async () => {
    const stop = startTurnHeartbeat('session-done', 'turn-done', 60_000)
    stop()
    expect(await releaseTurnsForHandoff()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // The reply the person already read must reach the row before the process
  // goes away: the row is the only copy a desktop quit leaves behind (SHO-274).
  // -------------------------------------------------------------------------

  test('flushes a live tracker before handing its turn off', async () => {
    const flushed: string[] = []
    const unregister = registerTurnSnapshotFlusher('session-f', async () => {
      flushed.push('session-f')
    })
    const stop = startTurnHeartbeat('session-f', 'turn-f', 60_000)

    updateMany.mockClear()
    expect(await releaseTurnsForHandoff()).toBe(1)
    expect(flushed).toEqual(['session-f'])

    unregister()
    stop()
  })

  test('flushLiveSnapshots can target one session and survives a failing flusher', async () => {
    const ran: string[] = []
    const unA = registerTurnSnapshotFlusher('session-a', async () => {
      ran.push('a')
    })
    const unBroken = registerTurnSnapshotFlusher('session-b', async () => {
      throw new Error('database is going away with the process')
    })
    const unB = registerTurnSnapshotFlusher('session-b', async () => {
      ran.push('b')
    })

    expect(await flushLiveSnapshots('session-a')).toBe(1)
    expect(ran).toEqual(['a'])

    // The broken tracker must not stop the one next to it.
    expect(await flushLiveSnapshots('session-b')).toBe(2)
    expect(ran).toContain('b')

    unA()
    unB()
    unBroken()
  })

  test('an unregistered tracker is not flushed', async () => {
    const ran: string[] = []
    const unregister = registerTurnSnapshotFlusher('session-g', async () => {
      ran.push('g')
    })
    unregister()

    expect(await flushLiveSnapshots('session-g')).toBe(0)
    expect(ran).toEqual([])
  })

  test('a fresh boot clears the turns the previous process was running', async () => {
    // No runtime from the previous process survives boot, so each of these is
    // dead even though its heartbeat is seconds old.
    findMany.mockResolvedValueOnce([
      { id: 'session-dead', activeTurnId: 'turn-dead' },
      { id: 'session-raced', activeTurnId: 'turn-raced' },
    ] as never)
    updateMany
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 0 } as never)

    expect(await sweepDeadTurnsOnLocalBoot()).toBe(1)

    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'session-dead', activeTurnId: 'turn-dead' }, data: CLEARED })
    // A turn another process already cleared is not counted twice.
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'session-raced', activeTurnId: 'turn-raced' }, data: CLEARED })
  })

  test('a boot with no active turns writes nothing', async () => {
    findMany.mockResolvedValueOnce([] as never)
    updateMany.mockClear()

    expect(await sweepDeadTurnsOnLocalBoot()).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // A chat open in two windows: the turn state is the one place every starter
  // and ender passes through, so the announcement lives here (SHO-299).
  // -------------------------------------------------------------------------

  const projectSession = {
    contextType: 'project',
    workspaceId: null,
    createdByUserId: null,
    project: { workspaceId: 'workspace-1' },
  }

  test('publishes a started turn to the chat workspace', async () => {
    published.length = 0
    findUnique.mockResolvedValueOnce(projectSession as never)

    await markTurnStarted('session-1', 'turn-1')

    expect(published).toEqual([
      {
        workspaceId: 'workspace-1',
        event: { type: 'chat-session.turn', chatSessionId: 'session-1', turnId: 'turn-1', state: 'started' },
        audience: null,
      },
    ])
  })

  test('a turn the server replayed is not announced to other windows', async () => {
    // SHO-53: a queued/wake turn must not make a window nobody is looking at
    // attach — an attach arms the task watch and the late-turn poll.
    published.length = 0
    findUnique.mockResolvedValueOnce(projectSession as never)

    await markTurnStarted('session-1', 'turn-1', { announce: false })

    expect(published).toEqual([])
  })

  test('publishes ended only when it cleared the turn', async () => {
    published.length = 0
    findUnique.mockResolvedValueOnce(projectSession as never)
    await markTurnEnded('session-1', 'turn-1')
    expect(published.map((entry) => entry.event.state)).toEqual(['ended'])

    // A duplicate or stale completion cleared nothing, so there is no turn to
    // announce — a second `ended` would repaint a window that is already right.
    published.length = 0
    updateMany.mockResolvedValueOnce({ count: 0 } as never)
    await markTurnEnded('session-1', 'turn-1')
    expect(published).toEqual([])
  })

  test('a personal workspace chat is announced only to its owner', async () => {
    published.length = 0
    findUnique.mockResolvedValueOnce({
      contextType: 'workspace',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      project: null,
    } as never)

    await markTurnStarted('session-1', 'turn-1')

    expect(published[0]).toMatchObject({ workspaceId: 'workspace-1', audience: ['user-1'] })
  })

  test('a publish failure never fails the turn', async () => {
    published.length = 0
    findUnique.mockRejectedValueOnce(new Error('database is down') as never)

    await expect(markTurnStarted('session-1', 'turn-1')).resolves.toBe('turn-1')
    expect(published).toEqual([])
  })
})
