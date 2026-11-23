// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-508 acceptance — a desktop install is never told "Workspace plan: Free".
 *
 * Desktop has no `Subscription` row, so `getEffectivePlanId` answered `free` to
 * everything; `stampWorkspacePlan` wrote that into the system prompt as
 * `Workspace plan: **Free**` and agents then refused heartbeats, schedules and
 * models that work on the machine (`localBilling.hasPaidSubscription` is `true`,
 * and `updateHeartbeatConfig` would have allowed it). The plan an agent is told
 * about is now the *linked cloud* account's, plus a "no plan limits here" line.
 *
 * This test feeds real values through the real modules: `billing.service`'s
 * plan resolution, the route-level stamp, and the runtime's own account-context
 * parser + prompt builder. Only the cloud hop (`fetchUpstream`) and prisma are
 * mocked.
 *
 *   bun test src/__tests__/desktop-plan-stamp.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'

// Captured at module load by `billing.service`, so it must be set before the
// dynamic imports below. Test files run isolated, one process each.
process.env.SHOGO_LOCAL_MODE = 'true'

let planBody: unknown = { ok: true, planId: 'pro', paidTier: true }
let upstreamFails: 'throw' | 'hang' | null = null
let linkedWorkspaceId: string | null = 'cloud-ws-1'

const fetchUpstreamMock = mock(async (_path: string, init?: RequestInit & { search?: string }) => {
  if (upstreamFails === 'throw') throw new Error('ECONNREFUSED cloud.test')
  if (upstreamFails === 'hang') {
    // Answer only when the caller's own timeout aborts the read, which is what
    // a slow cloud looks like from the chat stamp path.
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
    })
  }
  return new Response(JSON.stringify(planBody), { status: 200 })
})

// Desktop has no rows in either table — which is the whole bug. The mock says
// so explicitly so a `free` answer can only come from the local lookup.
const subscriptionFindFirst = mock(async (_args: any): Promise<any> => null)
const grantFindMany = mock(async (_args: any): Promise<any[]> => [])

mock.module('../lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: subscriptionFindFirst },
    workspaceGrant: { findMany: grantFindMany },
  },
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// Spread the real module and replace only the cloud hop: `billing.service`'s
// graph pulls other exports (`isLocalMode`, the visible-model readers) through
// here, and a partial factory breaks those imports outright.
const actualFederated = await import('../lib/federated-upstream')

mock.module('../lib/federated-upstream', () => ({
  ...actualFederated,
  fetchUpstream: fetchUpstreamMock,
  getUpstreamWorkspaceId: async () => linkedWorkspaceId,
  getUpstreamCredential: async () => 'shogo_sk_linked',
}))

const { getEffectivePlanId, getPlanStamp } = await import('../services/billing.service')
const { stampWorkspacePlan } = await import('../lib/stamp-workspace-plan')
const { _resetLinkedCloudPlanCache } = await import('../lib/linked-cloud-plan')
const { parseAccountContext, buildAccountContextPrompt } = await import(
  '../../../../packages/agent-runtime/src/account-context'
)

beforeEach(() => {
  planBody = { ok: true, planId: 'pro', paidTier: true }
  upstreamFails = null
  linkedWorkspaceId = 'cloud-ws-1'
  fetchUpstreamMock.mockClear()
  _resetLinkedCloudPlanCache()
})

afterEach(() => {
  _resetLinkedCloudPlanCache()
})

/** The exact block the runtime renders for the body the API stamped. */
function accountBlock(body: Record<string, unknown>): string {
  return buildAccountContextPrompt(parseAccountContext(body)) ?? ''
}

describe('SHO-508 — desktop plan stamp', () => {
  test('AC1: the plan is the linked cloud account plan, never free', async () => {
    expect(await getEffectivePlanId('local-ws')).toBe('pro')
    expect(await getPlanStamp('local-ws')).toEqual({ planId: 'pro', desktopUnlimited: true })

    // The local rows can only ever answer free; they must not be consulted.
    expect(subscriptionFindFirst).not.toHaveBeenCalled()
    expect(grantFindMany).not.toHaveBeenCalled()
  })

  test('AC2: the stamp carries the cloud plan plus the no-limits flag, and the prompt says so', async () => {
    const body: Record<string, unknown> = {}
    await stampWorkspacePlan(body, 'local-ws')

    expect(body.planId).toBe('pro')
    expect(body.desktopUnlimited).toBe(true)

    const block = accountBlock(body)
    expect(block).not.toContain('Free')
    expect(block).toContain('no plan limits')
    expect(block).toContain('Heartbeats, schedules, models')
    expect(block).toContain('Linked Shogo Cloud account plan: **Pro**')
  })

  test('AC3: unlinked desktop stamps no planId and never renders "Workspace plan: **Free**"', async () => {
    linkedWorkspaceId = null

    const body: Record<string, unknown> = {}
    await stampWorkspacePlan(body, 'local-ws')

    expect('planId' in body).toBe(false)
    expect(body.desktopUnlimited).toBe(true)

    const block = accountBlock(body)
    expect(block).not.toContain('Workspace plan: **Free**')
    expect(block).toContain('no plan limits')
    // Nothing to fetch: no cloud workspace is linked.
    expect(fetchUpstreamMock).not.toHaveBeenCalled()
  })

  test('AC4: a failed cloud read keeps the last good plan and never throws into the chat', async () => {
    const t0 = new Date('2026-11-22T00:00:00Z')
    setSystemTime(t0)
    try {
      expect(await getLinkedPlan()).toBe('pro')

      // Past the 5-minute window, so the next call really does re-read — and
      // this time the cloud is gone.
      upstreamFails = 'throw'
      setSystemTime(new Date(t0.getTime() + 6 * 60 * 1000))
      expect(await getLinkedPlan()).toBe('pro')

      const body: Record<string, unknown> = {}
      await expect(stampWorkspacePlan(body, 'local-ws')).resolves.toBeUndefined()
      expect(body.planId).toBe('pro')
      expect(body.desktopUnlimited).toBe(true)
    } finally {
      setSystemTime()
    }
  })

  test('AC4: a hanging cloud read gives up in about 2s and the chat still stamps', async () => {
    upstreamFails = 'hang'
    const started = Date.now()
    const body: Record<string, unknown> = {}
    await stampWorkspacePlan(body, 'local-ws')
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(3_000)
    expect('planId' in body).toBe(false)
    expect(body.desktopUnlimited).toBe(true)
    expect(body.canPublishSubdomain).toBe(true)
  })

  test('AC4: a second read inside the cache window makes no upstream request', async () => {
    expect(await getLinkedPlan()).toBe('pro')
    expect(await getLinkedPlan()).toBe('pro')
    expect(fetchUpstreamMock).toHaveBeenCalledTimes(1)
  })

  test('a cloud that reports no plan is "unknown", not free', async () => {
    planBody = { ok: true }
    expect(await getEffectivePlanId('local-ws')).toBe('free') // flattened signature
    expect(await getPlanStamp('local-ws')).toEqual({ planId: null, desktopUnlimited: true })
  })
})

async function getLinkedPlan() {
  const { getLinkedCloudPlanId } = await import('../lib/linked-cloud-plan')
  return getLinkedCloudPlanId()
}
