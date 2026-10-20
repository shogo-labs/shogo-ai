// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P6 acceptance — the desktop's relayed publish, billed like a cloud one.
 *
 * A relayed post is the cloud's only view of an X charge: the desktop composes,
 * the cloud forwards and keeps the legs. What must hold is that a leg the
 * provider never published is never billed — a *draft* is not a post — while a
 * real publish is billed exactly once, at provider cost × 1.20.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient } = await import('../client')
const { relayOperation } = await import('../relay.service')
const { SOCIAL_X_POST_USD, setSocialUsageWallet } = await import('../usage.service')

const db = prisma as any

interface Charge {
  actionType: string
  rawUsd: number
  billedUsd: number
}

let charges: Charge[] = []
let providerCalls: any[] = []
let providerPostId = 0

const fakeWallet = {
  async consume(params: any) {
    charges.push({
      actionType: params.actionType,
      rawUsd: params.rawUsd,
      billedUsd: params.billedUsd,
    })
    await db.usageEvent.create({
      data: {
        workspaceId: params.workspaceId,
        projectId: null,
        memberId: params.memberId,
        actionType: params.actionType,
        rawUsd: params.rawUsd,
        billedUsd: params.billedUsd,
        source: 'monthly',
        balanceBefore: 0,
        balanceAfter: 0,
      },
    })
    return { success: true }
  },
  async checkBalance() {
    return { ok: true }
  },
}

let workspaceId = ''
const suffix = crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: `qa-relay-meter-${suffix}`, slug: `qa-relay-meter-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `qa_zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'QA Relay',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa_x_${suffix}`,
      platform: 'x',
      username: 'qa_x',
      isActive: true,
    },
  })
})

beforeEach(() => {
  charges = []
  providerCalls = []
  setSocialUsageWallet(fakeWallet as any)
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      providerCalls.push(req)
      if (req.path === '/posts' && req.method === 'POST') {
        providerPostId += 1
        return { id: `zpost_${providerPostId}_${suffix}` }
      }
      return {}
    },
  } as any)
})

afterAll(async () => {
  setSocialClient(null)
  setSocialUsageWallet(null)
  await db.socialPostTarget.deleteMany({ where: { post: { workspaceId } } })
  await db.socialPost.deleteMany({ where: { workspaceId } })
  await db.socialAccount.deleteMany({ where: { workspaceId } })
  await db.socialProfile.deleteMany({ where: { workspaceId } })
  await db.usageEvent.deleteMany({ where: { workspaceId } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
})

function xPostBody(extra: Record<string, unknown>) {
  return {
    content: 'a post with a link https://example.com',
    platforms: [{ platform: 'x', accountId: `qa_x_${suffix}` }],
    ...extra,
  }
}

describe('a relayed X post is billed when it is published, not when it is written', () => {
  test('a draft the desktop saves charges nothing', async () => {
    const outcome = await relayOperation({
      workspaceId,
      method: 'POST',
      path: '/posts',
      query: {},
      body: xPostBody({ draft: true }),
    })

    // The call itself succeeded — the draft exists at the provider.
    expect(outcome.status).toBe(200)
    expect(providerCalls).toHaveLength(1)

    // But nothing was published, so X charges nothing and neither do we.
    expect(charges.filter((charge) => charge.actionType === 'social_x_api')).toHaveLength(0)
  })

  test('publishing it now charges one leg at provider cost × 1.20', async () => {
    const outcome = await relayOperation({
      workspaceId,
      method: 'POST',
      path: '/posts',
      query: {},
      body: xPostBody({ publishNow: true }),
    })
    expect(outcome.status).toBe(200)

    const xCharges = charges.filter((charge) => charge.actionType === 'social_x_api')
    expect(xCharges).toHaveLength(1)
    // A link costs $0.20 at the provider, so the workspace pays $0.24.
    expect(xCharges[0]!.rawUsd).toBeCloseTo(0.2, 10)
    expect(xCharges[0]!.billedUsd).toBeCloseTo(0.24, 10)
    expect(SOCIAL_X_POST_USD).toBeLessThan(0.2)
  })
})
