// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-347: the team-chat background loops run once per region per minute, not
 * once per pod per minute.
 *
 * `withGlobalJobLock` is a per-database advisory lock, so it only serialises
 * pods *inside* a region: the lock is released when pod A finishes and pod B,
 * whose timer fired 3 s later, then runs the identical query. These tests hold
 * the claim that actually reduces it to one run, from three pods at once.
 */

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'

const MINUTE = 60_000
const FAST_WINDOW_MS = 30 * MINUTE
const FULL_WINDOW_MS = 90 * 24 * 60 * MINUTE

const state = {
  settings: new Map<string, string>(),
  sweeps: 0,
  indexCalls: [] as number[],
}

const platformSetting = {
  updateMany: async ({ where, data }: any) => {
    const current = state.settings.get(where.key)
    if (current === undefined || !(current < where.value.lt)) return { count: 0 }
    state.settings.set(where.key, data.value)
    return { count: 1 }
  },
  create: async ({ data }: any) => {
    if (state.settings.has(data.key)) {
      const err: any = new Error('Unique constraint failed on the fields: (`key`)')
      err.code = 'P2002'
      throw err
    }
    state.settings.set(data.key, data.value)
    return data
  },
}

mock.module('../../lib/prisma', () => ({ prisma: { platformSetting } }))
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => Promise<unknown>) => ({
    acquired: true,
    result: await body(),
  }),
  KNOWN_JOB_IDS: {},
}))
mock.module('../../services/conversation-agent-dispatcher', () => ({
  sweepDeadAgentReplies: async () => {
    state.sweeps++
    return 0
  },
}))
// The sibling workers in this file are not under test; keep their import graph
// (email templates, reminders) out of the process.
mock.module('../../services/chat-digest', () => ({ runDigestPass: async () => {} }))
mock.module('../../services/chat-items', () => ({
  fireDueReminders: async () => {},
  sendDueScheduledMessages: async () => {},
}))
mock.module('../../services/conversation-file-index', () => ({
  chunkPendingAttachments: async () => false,
  embedPendingChunks: async () => false,
}))
mock.module('../../services/conversation-semantic', () => ({
  embeddingProvider: () => ({ model: 'test', embed: async () => [] }),
  indexPendingMessages: async (_now?: Date, _batch?: number, windowMs?: number) => {
    state.indexCalls.push(windowMs ?? FULL_WINDOW_MS)
    return 0
  },
  INDEX_FAST_WINDOW_MS: FAST_WINDOW_MS,
  INDEX_WINDOW_MS: FULL_WINDOW_MS,
}))

const { claimRegionPeriod } = await import('../../lib/region-period-claim')
const { runDeadAgentReplySweep, SWEEP_INTERVAL_MS } = await import('../run-chat-sweep')
const { runChannelIndexer } = await import('../run-channel-workers')

const T0 = new Date(Date.UTC(2026, 10, 5, 12, 0, 7))

beforeEach(() => {
  state.settings.clear()
  state.sweeps = 0
  state.indexCalls = []
  setSystemTime(T0)
})

afterEach(() => setSystemTime())

describe('claimRegionPeriod', () => {
  it('one winner out of three pods racing in the same region-minute', async () => {
    const wins = await Promise.all([
      claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1'),
      claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1'),
      claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1'),
    ])
    expect(wins.filter(Boolean)).toHaveLength(1)
  })

  it('a second region claims the same minute independently', async () => {
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1')).toBe(true)
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'eu-frankfurt-1')).toBe(true)
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1')).toBe(false)
  })

  it('opens again in the next period, and every later one', async () => {
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, T0, 'us-ashburn-1')).toBe(true)
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, new Date(T0.getTime() + MINUTE), 'us-ashburn-1')).toBe(true)
    expect(await claimRegionPeriod('chat-dead-reply-sweep', MINUTE, new Date(T0.getTime() + 45_000), 'us-ashburn-1')).toBe(false)
  })

  it('a claim of a different period length does not block the minute claim', async () => {
    expect(await claimRegionPeriod('channels-indexer-full', 60 * MINUTE, T0, 'us-ashburn-1')).toBe(true)
    expect(await claimRegionPeriod('channels-indexer', MINUTE, T0, 'us-ashburn-1')).toBe(true)
  })
})

describe('the dead-reply sweep', () => {
  it('polls every 60 s — the stale window plus one tick is the worst-case settle time', () => {
    expect(SWEEP_INTERVAL_MS).toBe(60_000)
  })

  it('runs once for three pods in one region-minute, then again in the next', async () => {
    await Promise.all([runDeadAgentReplySweep(), runDeadAgentReplySweep(), runDeadAgentReplySweep()])
    expect(state.sweeps).toBe(1)

    setSystemTime(new Date(T0.getTime() + 20_000))
    await Promise.all([runDeadAgentReplySweep(), runDeadAgentReplySweep()])
    expect(state.sweeps).toBe(1)

    setSystemTime(new Date(T0.getTime() + 61_000))
    await Promise.all([runDeadAgentReplySweep(), runDeadAgentReplySweep(), runDeadAgentReplySweep()])
    expect(state.sweeps).toBe(2)
  })
})

describe('the search indexer', () => {
  it('runs the fast pass once for three pods in one region-minute', async () => {
    // The first tick of a fresh key is a full pass — a deploy should clear any
    // backlog rather than wait for the hour to come round.
    await runChannelIndexer()
    expect(state.indexCalls).toEqual([FULL_WINDOW_MS])

    state.indexCalls = []
    setSystemTime(new Date(T0.getTime() + 61_000))
    await Promise.all([runChannelIndexer(), runChannelIndexer(), runChannelIndexer()])
    expect(state.indexCalls).toEqual([FAST_WINDOW_MS])
  })

  it('runs the full 90-day pass once an hour instead of every tick', async () => {
    await runChannelIndexer()
    state.indexCalls = []

    setSystemTime(new Date(T0.getTime() + 60 * MINUTE))
    await Promise.all([runChannelIndexer(), runChannelIndexer(), runChannelIndexer()])
    expect(state.indexCalls).toEqual([FULL_WINDOW_MS])

    // The next tick in the same hour is a fast pass again.
    state.indexCalls = []
    setSystemTime(new Date(T0.getTime() + 61 * MINUTE))
    await runChannelIndexer()
    expect(state.indexCalls).toEqual([FAST_WINDOW_MS])
  })
})
