// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 — `GET running-agents` asks the queue once, not once per row.
 *
 * The route ran `agentReplySlotState` per row (up to 50), which in the cloud is
 * a Redis round trip each, while the desktop's API event loop was busy serving
 * the screens polling that very route. `agentReplySlotStates` is the batched
 * form, and it must answer exactly what the singular one does.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../agent-reply-capacity', () => ({
  resolveAgentReplyCapacity: async () => ({ limit: 50 }),
}))

const evals: string[][] = []

/** A Redis that knows a fixed set of queued run ids at fixed positions. */
function fakeRedis(positions: Record<string, number>) {
  return {
    eval: mock(async (_script: string, _keys: number, _key: string, ...runIds: string[]) => {
      evals.push(runIds)
      return runIds.map((id) => positions[id] ?? 0)
    }),
    zrem: mock(async () => 1),
    zadd: mock(async () => 1),
  } as any
}

const {
  agentReplySlotState,
  agentReplySlotStates,
  _setAgentReplySlotsRedisForTests,
} = await import('../agent-reply-slots')

beforeEach(() => {
  evals.length = 0
})

afterAll(() => {
  _setAgentReplySlotsRedisForTests(undefined)
})

describe('agentReplySlotStates', () => {
  test('answers the same as the singular call for every run', async () => {
    _setAgentReplySlotsRedisForTests(fakeRedis({ 'run-2': 2, 'run-5': 5 }))
    const runIds = ['run-1', 'run-2', 'run-3', 'run-5']

    const single = new Map<string, { state: string; position: number | null }>()
    for (const runId of runIds) single.set(runId, await agentReplySlotState('ws-batch', runId))
    evals.length = 0

    const batched = await agentReplySlotStates('ws-batch', runIds)

    expect([...batched.entries()]).toEqual([...single.entries()])
    // Queued runs get their position, unknown runs read as running.
    expect(batched.get('run-2')).toEqual({ state: 'queued', position: 2 })
    expect(batched.get('run-1')).toEqual({ state: 'running', position: null })
  })

  test('one queue round trip for fifty rows', async () => {
    _setAgentReplySlotsRedisForTests(fakeRedis({}))
    evals.length = 0
    const runIds = Array.from({ length: 50 }, (_, i) => `run-${i}`)

    const batched = await agentReplySlotStates('ws-batch', runIds)

    expect(batched.size).toBe(50)
    expect(evals).toHaveLength(1)
    expect(evals[0]).toHaveLength(50)
  })

  test('no rows and no queue: no round trip at all', async () => {
    _setAgentReplySlotsRedisForTests(fakeRedis({}))
    evals.length = 0
    expect((await agentReplySlotStates('ws-empty', [])).size).toBe(0)
    expect(evals).toHaveLength(0)
  })
})
