// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA (SHO-508) — the whole turn, end to end: a client chat body is stamped by
 * the chat route's helper, parsed by the runtime, and rendered into the Account
 * block the model actually reads.
 *
 * The dev's `desktop-plan-stamp.acceptance.test.ts` covers the stamp and the
 * prompt builder separately. This file joins them through the exact seam the
 * bug travelled — `stampWorkspacePlan` → `parseAccountContext` — because that
 * is the shape that reaches production: a desktop install signed into a paid
 * cloud account was told `Workspace plan: **Free**` on every turn, and an agent
 * then refused (and in Russell's case undid) heartbeats that
 * `localBilling.hasPaidSubscription` allows.
 *
 * Fails on `main` (which stamps `planId: 'free'`): asserts on the *rendered
 * prompt*, not on any new API.
 *
 *   bun test src/__tests__/qa-sho508-desktop-turn-prompt.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Captured at module load by `billing.service`; set before the imports below.
process.env.SHOGO_LOCAL_MODE = 'true'

let planBody: unknown = { ok: true, planId: 'pro', paidTier: true }
let linkedWorkspaceId: string | null = 'cloud-ws-1'

const fetchUpstreamMock = mock(async (_path: string, _init?: RequestInit & { search?: string }) =>
  new Response(JSON.stringify(planBody), { status: 200 }),
)

// Desktop has no billing rows at all — that is the bug: the local lookup can
// only answer `free`. The cloud says `pro`.
mock.module('../lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: mock(async (_args: any): Promise<any> => null) },
    workspaceGrant: { findMany: mock(async (_args: any): Promise<any[]> => []) },
  },
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// Spread the real module: `billing.service`'s graph imports other exports from
// here, and a partial factory breaks those imports outright.
const actualFederated = await import('../lib/federated-upstream')
mock.module('../lib/federated-upstream', () => ({
  ...actualFederated,
  fetchUpstream: fetchUpstreamMock,
  getUpstreamWorkspaceId: async () => linkedWorkspaceId,
  getUpstreamCredential: async () => 'shogo_sk_linked',
}))

const { stampWorkspacePlan } = await import('../lib/stamp-workspace-plan')
const { _resetLinkedCloudPlanCache } = await import('../lib/linked-cloud-plan')
const runtime = await import('../../../../packages/agent-runtime/src/account-context')

/** What the runtime renders for a body the chat route forwarded. */
function accountBlockFor(body: Record<string, unknown>): string {
  return runtime.buildAccountContextPrompt(runtime.parseAccountContext(body)) ?? ''
}

beforeEach(() => {
  planBody = { ok: true, planId: 'pro', paidTier: true }
  linkedWorkspaceId = 'cloud-ws-1'
  fetchUpstreamMock.mockClear()
  _resetLinkedCloudPlanCache()
})

afterEach(() => {
  _resetLinkedCloudPlanCache()
})

/** The body a desktop client posts to workspace/project chat, plus whatever the
 *  client fills in. Only the route-owned fields are asserted on. */
function clientTurnBody(): Record<string, unknown> {
  return {
    agentMode: 'auto',
    message: { text: 'turn my nightly heartbeat on' },
    timezone: 'Asia/Seoul',
  }
}

describe('SHO-508 QA — a desktop turn reaches the agent without a false Free plan', () => {
  test('the stamped turn renders no plan gate, and says paid-plan features work here', async () => {
    const body = clientTurnBody()
    await stampWorkspacePlan(body, 'local-ws')

    const block = accountBlockFor(body)

    // The production failure: "Workspace plan: **Free**" on a paid install.
    expect(block).not.toContain('Workspace plan')
    expect(block).not.toContain('Free')
    expect(block).toContain('Desktop install: this machine has no plan limits')
    expect(block).toContain('Heartbeats, schedules, models')
    // The cloud account is still named, so the agent can talk about upgrades.
    expect(block).toContain('Linked Shogo Cloud account plan: **Pro**')
    // The desktop publishing line is unchanged by this card.
    expect(block).toContain('- Publishing: static hosting only')
  })

  test('an unlinked desktop names no plan at all, and still says it is unlimited', async () => {
    linkedWorkspaceId = null
    const body = clientTurnBody()
    await stampWorkspacePlan(body, 'local-ws')

    expect('planId' in body).toBe(false)
    const block = accountBlockFor(body)
    expect(block).not.toContain('Free')
    expect(block).not.toContain('Workspace plan')
    expect(block).not.toContain('Linked Shogo Cloud account plan')
    expect(block).toContain('this machine has no plan limits')
  })

  test('the turn is stamped and readable twice — a second turn does not lose the context', async () => {
    const body = clientTurnBody()
    await stampWorkspacePlan(body, 'local-ws')
    const first = accountBlockFor(body)

    // The gateway replaces the whole context per request; the same stamped body
    // must render the same block again, and the cache must not re-hit the cloud.
    const second = accountBlockFor({ ...body })
    expect(second).toBe(first)
    expect(fetchUpstreamMock).toHaveBeenCalledTimes(1)
  })

  test('cloud parity: a Free cloud workspace still gets the paywall framing', async () => {
    // Runtime half of AC5 — no local-mode module state involved: without the
    // flag the plan line is exactly what cloud Free renders today.
    const cloud = runtime.buildAccountContextPrompt(
      runtime.parseAccountContext({ planId: 'free', canPublishSubdomain: false }),
    )!
    expect(cloud).toContain('Workspace plan: **Free**. This plan cannot publish')
    expect(cloud).not.toContain('no plan limits')
  })
})
