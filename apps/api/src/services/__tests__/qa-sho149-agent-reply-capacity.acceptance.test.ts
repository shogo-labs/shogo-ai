// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-149 AC8: how many agent replies may work at once, by plan
 * (Free 2, Basic 4, Pro 8, Business 12, Enterprise 24), 24 on desktop, the ops
 * override as the ceiling on both surfaces, and an admin who may lower it but
 * cannot exceed the plan.
 *
 * The capacity is cached for a minute, so every case clears it first — a change
 * has to apply without a restart.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const state = {
  local: false,
  plan: 'free' as string,
  /** What the workspace row holds. */
  configured: null as number | null,
  rowThrows: false,
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => {
        if (state.rowThrows) throw new Error('no db')
        return { agentReplyConcurrency: state.configured }
      },
    },
  },
}))

mock.module('../../lib/federated-upstream', () => ({ isLocalMode: () => state.local }))

mock.module('../billing.service', () => ({ getEffectivePlanId: async () => state.plan }))

const { resolveAgentReplyCapacity, resolveAgentReplyLimit, invalidateAgentReplyCapacity, LOCAL_AGENT_REPLY_CONCURRENCY_MAX } =
  await import('../agent-reply-capacity')

const WS = 'ws-149'

async function capacity() {
  invalidateAgentReplyCapacity()
  return resolveAgentReplyCapacity(WS)
}

beforeEach(() => {
  delete process.env.SHOGO_CHANNEL_AGENT_CONCURRENCY
  state.local = false
  state.plan = 'free'
  state.configured = null
  state.rowThrows = false
  invalidateAgentReplyCapacity()
})

describe('the plan ceiling in the cloud', () => {
  test('each plan admits its own number of agents', async () => {
    const expected: Record<string, number> = { free: 2, basic: 4, pro: 8, business: 12, enterprise: 24 }
    const seen: Record<string, number> = {}
    for (const plan of Object.keys(expected)) {
      state.plan = plan
      const c = await capacity()
      seen[plan] = c.limit
      expect(c).toMatchObject({ limit: expected[plan], max: expected[plan], defaultLimit: expected[plan], source: 'plan', planId: plan })
    }
    expect(seen).toEqual(expected)
  })

  test('a workspace may lower the number, but never go above its plan', async () => {
    state.plan = 'pro'
    state.configured = 3
    expect(await capacity()).toMatchObject({ limit: 3, max: 8, configured: 3 })

    // Written by a race or an older plan: the value is clamped, not trusted.
    state.configured = 40
    expect(await capacity()).toMatchObject({ limit: 8, max: 8 })

    state.configured = 0
    expect((await capacity()).limit).toBe(1)
  })
})

describe('desktop', () => {
  test('defaults to 24 and lets an admin reach 100', async () => {
    state.local = true
    expect(await capacity()).toMatchObject({
      limit: 24,
      max: LOCAL_AGENT_REPLY_CONCURRENCY_MAX,
      defaultLimit: 24,
      source: 'local',
    })

    state.configured = 100
    expect((await capacity()).limit).toBe(100)
    state.configured = 5
    expect((await capacity()).limit).toBe(5)
  })
})

describe('the ops override', () => {
  test('is the ceiling on both surfaces', async () => {
    process.env.SHOGO_CHANNEL_AGENT_CONCURRENCY = '3'
    state.plan = 'enterprise'
    expect(await capacity()).toMatchObject({ limit: 3, max: 3 })

    state.local = true
    expect(await capacity()).toMatchObject({ limit: 3, max: 3, source: 'local' })

    // A workspace set higher than the machine was told to run is clamped down.
    state.configured = 50
    expect((await capacity()).limit).toBe(3)
  })

  test('is ignored when it is not a usable number', async () => {
    process.env.SHOGO_CHANNEL_AGENT_CONCURRENCY = 'lots'
    state.plan = 'pro'
    expect(await capacity()).toMatchObject({ limit: 8, max: 8 })
  })
})

describe('a plan change', () => {
  test('applies as soon as the cache is cleared, without a restart', async () => {
    state.plan = 'free'
    expect(await resolveAgentReplyLimit(WS)).toBe(2)

    // The billing service invalidates on a plan change; the next admission sees it.
    state.plan = 'business'
    invalidateAgentReplyCapacity(WS)
    expect(await resolveAgentReplyLimit(WS)).toBe(12)
  })

  test('a lookup that cannot read the workspace still admits agents', async () => {
    state.plan = 'pro'
    state.rowThrows = true
    expect(await capacity()).toMatchObject({ limit: 8, configured: null })
  })
})
