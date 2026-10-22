// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The queue behind "agents working at once": admission at the limit, FIFO order,
 * parking while a run only waits on a tool, and a stopped run leaving the line.
 * The in-process backend is the one desktop (and any Redis-less server) uses.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const capacity = { limit: 1 }

mock.module('../agent-reply-capacity', () => ({
  resolveAgentReplyCapacity: async () => ({
    limit: capacity.limit,
    max: 24,
    defaultLimit: 24,
    configured: null,
    source: 'local',
    planId: 'free',
  }),
  resolveAgentReplyLimit: async () => capacity.limit,
  invalidateAgentReplyCapacity: () => {},
  agentReplyConcurrencyOverride: () => null,
}))
mock.module('../../lib/tunnel-redis', () => ({ getSharedRedis: () => null }))
mock.module('../../lib/conversation-bus', () => ({ publishConversationEvent: () => {} }))

const {
  enqueueAgentReplySlot,
  slotSnapshot,
  agentReplySlotState,
  drainAgentReplyWaiters,
  _resetAgentReplySlotsForTests,
} = await import('../agent-reply-slots')

const WORKSPACE = 'ws-1'

async function until(predicate: () => boolean, ms = 1_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the queue')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  _resetAgentReplySlotsForTests()
  capacity.limit = 1
})

describe('agent reply slots', () => {
  test('admits up to the limit, then queues the rest in arrival order', async () => {
    const first = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-b' })
    const third = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-c' })

    expect(first.state()).toBe('running')
    expect(second.state()).toBe('queued')
    expect(second.position()).toBe(1)
    expect(third.position()).toBe(2)

    const snapshot = await slotSnapshot(WORKSPACE)
    expect(snapshot).toMatchObject({ limit: 1, running: 1, queued: 2, parked: 0 })
  })

  test('releasing a slot admits the head of the queue', async () => {
    const first = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-b' })

    first.release()
    await until(() => second.state() === 'running')

    await second.acquired
    expect(second.position()).toBeNull()
    expect((await slotSnapshot(WORKSPACE)).running).toBe(1)
  })

  test('a parked run gives its slot away and can take one back over the limit', async () => {
    const first = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-b' })

    first.park()
    expect(first.state()).toBe('waiting')
    await until(() => second.state() === 'running')
    expect(await slotSnapshot(WORKSPACE)).toMatchObject({ running: 1, queued: 0, parked: 1 })

    // The parked turn starts generating again: it unparks ahead of the queue,
    // allowed over the limit because a running turn cannot pause.
    first.unpark()
    expect(first.state()).toBe('running')
    expect((await slotSnapshot(WORKSPACE)).running).toBe(2)
  })

  test('a run stopped while queued rejects and leaves the line', async () => {
    await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const controller = new AbortController()
    const queued = await enqueueAgentReplySlot({
      workspaceId: WORKSPACE,
      runId: 'run-b',
      signal: controller.signal,
    })

    expect(queued.state()).toBe('queued')
    controller.abort()

    await expect(queued.acquired).rejects.toThrow('stopped before it started')
    expect((await slotSnapshot(WORKSPACE)).queued).toBe(0)
  })

  test('a raised limit starts the replies that were already waiting', async () => {
    const first = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-b' })
    const third = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-c' })
    expect(second.state()).toBe('queued')
    expect(third.state()).toBe('queued')

    // The admin raises the limit; the route re-admits without waiting for a release.
    capacity.limit = 3
    await drainAgentReplyWaiters(WORKSPACE)

    expect(first.state()).toBe('running')
    expect(second.state()).toBe('running')
    expect(third.state()).toBe('running')
    expect((await slotSnapshot(WORKSPACE)).queued).toBe(0)
  })

  test('agentReplySlotState reports a run as running, waiting or queued with its place', async () => {
    const first = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: WORKSPACE, runId: 'run-b' })

    expect(await agentReplySlotState(WORKSPACE, 'run-a')).toEqual({ state: 'running', position: null })
    expect(await agentReplySlotState(WORKSPACE, 'run-b')).toEqual({ state: 'queued', position: 1 })

    first.park()
    expect(await agentReplySlotState(WORKSPACE, 'run-a')).toEqual({ state: 'waiting', position: null })
    second.release()
  })

  test('a run the queue has no record of is not reported as queued', async () => {
    // An orphaned running row (a restart, a lost book) must not read
    // "Queued · —" for the rest of its life.
    expect(await agentReplySlotState(WORKSPACE, 'run-unknown')).toEqual({
      state: 'running',
      position: null,
    })
  })
})
