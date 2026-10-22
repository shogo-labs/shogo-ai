// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Redis backend of the agent reply slot queue, against a real server.
 *
 * `agent-reply-slots.test.ts` forces the in-process backend, so the Lua that
 * actually runs in the cloud was never executed by a test. Every Redis call in
 * the service swallows its own errors (`catch(() => null)`), so a broken script
 * looks exactly like an empty queue: this file reads the keys back through a raw
 * client and drives two pods' worth of clients against the same workspace.
 *
 * What it pins down:
 *   - FIFO admission: the waiter list is scored by enqueue time, so the run that
 *     joined first is the one admitted when a slot frees (no jittered lottery).
 *   - The 2-minute holder lease: a fresh slot is written ~120 s into the future,
 *     so a pod that dies frees its slot in about a lease, not in two hours.
 *   - An expired holder and a dead pod's waiter are dropped, not counted.
 *
 * Opt-in locally; required in CI (the test job sets CI_REQUIRE_REDIS=1 and a
 * Redis service):
 *
 *   TEST_REDIS_URL=redis://localhost:6379 bun test agent-reply-slots.redis
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import Redis from 'ioredis'

const url = process.env.TEST_REDIS_URL

if (!url && process.env.CI_REQUIRE_REDIS === '1') {
  throw new Error(
    'CI_REQUIRE_REDIS=1 but TEST_REDIS_URL is not set: the reply slot queue\'s Lua scripts would go untested. ' +
      'Add a redis service to the test job.',
  )
}

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
mock.module('../../lib/conversation-bus', () => ({ publishConversationEvent: () => {} }))

const {
  enqueueAgentReplySlot,
  slotSnapshot,
  _resetAgentReplySlotsForTests,
  _setAgentReplySlotsRedisForTests,
} = await import('../agent-reply-slots')

/** The pod under test, and a second client standing in for another pod. */
let pod: Redis | null = null
let otherPod: Redis | null = null

const waitersKey = (workspaceId: string) => `chat:slotq:${workspaceId}`
const aliveKey = (workspaceId: string) => `chat:slotq:${workspaceId}:alive`
const holdersKey = (workspaceId: string) => `chat:slots:${workspaceId}`

/** A workspace per test: no cross-test state in Redis and no cleanup races. */
const workspace = () => `ws-${crypto.randomUUID()}`

async function until(predicate: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the queue')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

if (url) {
  pod = new Redis(url, { maxRetriesPerRequest: 2 })
  otherPod = new Redis(url, { maxRetriesPerRequest: 2 })
}

afterAll(() => {
  _setAgentReplySlotsRedisForTests(undefined)
  pod?.disconnect()
  otherPod?.disconnect()
})

beforeEach(() => {
  _resetAgentReplySlotsForTests()
  capacity.limit = 1
  _setAgentReplySlotsRedisForTests(pod as never)
})

describe.skipIf(!url)('agent reply slots on Redis', () => {
  test('admits FIFO across two pods: the run that joined first goes first', async () => {
    const ws = workspace()

    const first = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-a' })
    expect(first.state()).toBe('running')

    const second = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-b' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const third = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-c' })

    expect(second.state()).toBe('queued')
    expect(third.state()).toBe('queued')
    // The queue really lives in Redis, in enqueue order.
    expect(await otherPod!.zrange(waitersKey(ws), 0, -1)).toEqual(['run-b', 'run-c'])
    // And the holder holds a renewed lease, not the old two-hour one.
    const lease = Number(await otherPod!.zscore(holdersKey(ws), 'run-a'))
    expect(lease).toBeGreaterThan(Date.now() + 100_000)
    expect(lease).toBeLessThanOrEqual(Date.now() + 121_000)

    first.release()
    await until(() => second.state() === 'running')

    await second.acquired
    expect(second.position()).toBeNull()
    // The other pod sees the hand-off too, with the line moved up behind it.
    await until(async () => (await otherPod!.zcard(holdersKey(ws))) === 1)
    expect(await otherPod!.zrange(waitersKey(ws), 0, -1)).toEqual(['run-c'])
    expect(third.position()).toBe(1)

    second.release()
    await until(() => third.state() === 'running')
    third.release()
  })

  test('a queued run keeps its place across ticks and capacity reads', async () => {
    // The waiter's score is its enqueue time, not a lease, so nothing may prune
    // the line by score: a snapshot (which every capacity publish takes) must
    // count live waiters, and the join must write a liveness lease that is still
    // in the future when the next tick looks at it.
    const ws = workspace()
    const first = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-a' })
    const waiting = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-b' })
    expect(waiting.state()).toBe('queued')

    expect((await slotSnapshot(ws)).queued).toBe(1)
    expect((await slotSnapshot(ws)).queued).toBe(1)

    // Longer than one admission poll: the waiter ticks, is swept by the cleanup,
    // and would be gone if its lease had been written in the past.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(waiting.state()).toBe('queued')
    expect(waiting.position()).toBe(1)
    expect((await slotSnapshot(ws)).queued).toBe(1)

    first.release()
    await until(() => waiting.state() === 'running')
    waiting.release()
  })

  test('a dead pod frees its slot within one lease, and its waiter drops out', async () => {
    const ws = workspace()
    const now = Date.now()

    // A pod that died holding a slot, and one that died in line.
    await otherPod!.zadd(holdersKey(ws), String(now - 1_000), 'ghost-holder')
    await otherPod!.zadd(waitersKey(ws), String(now - 120_000), 'ghost-waiter')

    // Nothing about that ghost should keep the next run out.
    const survivor = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-a' })
    expect(survivor.state()).toBe('running')

    // The expired holder is gone rather than counted.
    expect(await otherPod!.zscore(holdersKey(ws), 'ghost-holder')).toBeNull()
    expect(await otherPod!.zscore(waitersKey(ws), 'ghost-waiter')).toBeNull()

    const snapshot = await slotSnapshot(ws)
    expect(snapshot).toMatchObject({ running: 1, queued: 0 })

    survivor.release()
  })

  test('parking on the Redis backend frees the slot for the next run', async () => {
    const ws = workspace()
    const first = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-a' })
    const second = await enqueueAgentReplySlot({ workspaceId: ws, runId: 'run-b' })
    expect(second.state()).toBe('queued')

    // run-a is only waiting on a tool: it gives the slot back.
    first.park()
    expect(first.state()).toBe('waiting')
    expect(await otherPod!.zscore(holdersKey(ws), 'run-a')).toBeNull()

    await until(() => second.state() === 'running')
    expect((await slotSnapshot(ws)).running).toBe(1)

    // Its next content frame re-takes a slot ahead of the queue, over the limit.
    first.unpark()
    expect(first.state()).toBe('running')
    await until(async () => (await otherPod!.zcard(holdersKey(ws))) === 2)

    first.release()
    second.release()
  })
})
