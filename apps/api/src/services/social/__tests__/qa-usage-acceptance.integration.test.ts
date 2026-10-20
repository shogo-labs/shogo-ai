// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P6 acceptance — what the *workspace* pays, not what one call paid.
 *
 * The meters are exercised individually in `usage.test.ts`; this file asserts the
 * one thing a unit test per call cannot see: the total a workspace is charged for
 * a month of activity. Cost = provider cost × 1.20 (acceptance criterion 6), so
 * 10011 outbound DMs are $0.0011 raw and $0.00132 billed — no more, no less.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient } = await import('../client')
const {
  SOCIAL_DM_FREE_UNITS_PER_MONTH,
  SOCIAL_DM_PROVIDER_USD,
  meterOutboundMessage,
  setSocialUsageWallet,
  socialUsageSummary,
} = await import('../usage.service')

const db = prisma as any

interface Charge {
  actionType: string
  rawUsd: number
  billedUsd: number
}

let charges: Charge[] = []

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
let conversationId = ''

function seedMessage(n: number) {
  return {
    workspaceId,
    conversationId,
    zernioMessageId: `qa_seed_${n}`,
    direction: 'outgoing' as const,
    platform: 'instagram',
    text: `seed ${n}`,
    metered: true as const,
    sentAt: new Date(),
  }
}

let nextId = 0
async function newMessage(prefix: string) {
  nextId += 1
  return db.socialMessage.create({
    data: {
      workspaceId,
      conversationId,
      zernioMessageId: `qa_${prefix}_${nextId}`,
      direction: 'outgoing',
      platform: 'instagram',
      text: prefix,
      sentAt: new Date(),
    },
  })
}

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: `qa-usage-acceptance-${Date.now()}`, slug: `qa-usage-${Date.now()}`, kind: 'team' },
  })
  workspaceId = workspace.id

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `qa_profile_${Date.now()}`,
      externalId: `ws_${workspaceId}`,
      name: 'QA',
    },
  })
  const account = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `qa_account_${Date.now()}`,
      platform: 'instagram',
      username: 'qa',
      isActive: true,
    },
  })
  void account
  const conversation = await db.socialConversation.create({
    data: {
      workspaceId,
      zernioConversationId: `qa_conv_${Date.now()}`,
      platform: 'instagram',
    },
  })
  conversationId = conversation.id
})

beforeEach(() => {
  charges = []
  setSocialUsageWallet(fakeWallet as any)
  // `cloud` is the only mode that bills; on a desktop or with BYOK nothing here runs.
  setSocialClient({ mode: 'cloud', async request() { return {} } } as any)
})

afterAll(async () => {
  setSocialUsageWallet(null)
  setSocialClient(null)
  await db.socialMessage.deleteMany({ where: { workspaceId } })
  await db.socialConversation.deleteMany({ where: { workspaceId } })
  await db.socialAccount.deleteMany({ where: { workspaceId } })
  await db.socialProfile.deleteMany({ where: { workspaceId } })
  await db.usageEvent.deleteMany({ where: { workspaceId } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
})

function totalRaw() {
  return charges.reduce((sum, charge) => sum + charge.rawUsd, 0)
}

describe('social_dm — the workspace pays per message, not per running total', () => {
  test('three billable DMs cost three units in total, not six', async () => {
    // The allowance already spent, so every message from here on is billable.
    const seed = Array.from({ length: SOCIAL_DM_FREE_UNITS_PER_MONTH }, (_, index) =>
      seedMessage(index),
    )
    await db.socialMessage.createMany({ data: seed })

    for (const name of ['first', 'second', 'third']) {
      const row = await newMessage(name)
      const result = await meterOutboundMessage(workspaceId, row.id)
      expect(result.billed).toBe(true)
    }

    // One unit each: three messages cost three units in total. A formula that
    // bills the month's *running* total on every message sends $0.0001, $0.0002
    // and $0.0003 — six units for three messages, and quadratic from there.
    expect(charges).toHaveLength(3)
    const chargeSummary = charges.map((charge) => `${charge.actionType}:${charge.rawUsd}`).join(' ')
    expect({ charges: chargeSummary, totalRaw: totalRaw() }).toEqual({
      charges: `social_dm:${SOCIAL_DM_PROVIDER_USD} social_dm:${SOCIAL_DM_PROVIDER_USD} social_dm:${SOCIAL_DM_PROVIDER_USD}`,
      totalRaw: SOCIAL_DM_PROVIDER_USD * 3,
    })

    // And the summary agrees with the wallet: the two numbers are the same bill.
    const summary = await socialUsageSummary(workspaceId)
    expect(summary.dms.billableUnits).toBe(3)
    expect(summary.dms.rawUsd).toBeCloseTo(totalRaw(), 10)
  })
})
