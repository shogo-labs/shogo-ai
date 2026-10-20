// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P6 — the three meters, against a real SQLite database with the wallet
 * stood in for at the seam.
 *
 * What has to hold, because these are the ways a meter goes wrong:
 *   - a workspace gets its 10k free DMs, and the 10,001st costs exactly $0.0001;
 *   - the same message or post leg is never billed twice, however many paths see
 *     it (webhook echo, reply path, sweep);
 *   - a wallet failure gives the claim back instead of losing the charge;
 *   - X's link price applies, and only X is charged per post;
 *   - everything is provider cost × `MARKUP_MULTIPLIER`, nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient } = await import('../client')
const {
  SOCIAL_ACCOUNT_BANDS,
  SOCIAL_DM_FREE_UNITS_PER_MONTH,
  SOCIAL_DM_PROVIDER_USD,
  SOCIAL_X_POST_USD,
  SOCIAL_X_POST_WITH_LINK_USD,
  assertSocialBudget,
  contentHasLink,
  meterOutboundMessage,
  meterXPost,
  projectedConnectRawUsd,
  projectedPublishRawUsd,
  setSocialUsageWallet,
  socialAccountBand,
  socialAccountMonthlyRawUsd,
  socialBilledUsd,
  socialUsageSummary,
  startOfMonthUtc,
  sweepPendingSocialUsage,
} = await import('../usage.service')

const db = prisma as any

interface Charge {
  workspaceId: string
  actionType: string
  rawUsd: number
  billedUsd: number
  actionMetadata: Record<string, unknown>
}

let charges: Charge[] = []
let walletDown = false
let balanceOk = true
let balanceReason: string | undefined

const fakeWallet = {
  async consume(params: any) {
    if (walletDown) return { success: false, error: 'wallet offline' }
    charges.push({
      workspaceId: params.workspaceId,
      actionType: params.actionType,
      rawUsd: params.rawUsd,
      billedUsd: params.billedUsd,
      actionMetadata: params.actionMetadata ?? {},
    })
    // Mirror what the real wallet leaves behind: the `UsageEvent` the monthly
    // sweep reads back to know what it has already charged this month.
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
    return balanceOk ? { ok: true } : { ok: false, reason: balanceReason ?? 'usage_limit_reached' }
  },
}

let workspaceId = ''
let accountRowId = ''
let conversationId = ''
let postId = ''

function messageNumber(n: number) {
  return {
    workspaceId,
    conversationId,
    zernioMessageId: `seed_${n}`,
    direction: 'outgoing' as const,
    platform: 'instagram',
    text: `seed ${n}`,
    metered: true as const,
    sentAt: new Date(),
  }
}

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: 'Meter Co', slug: `meter-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: 'zp_meter',
      externalId: `ws_${workspaceId}`,
      name: 'Meter Co',
    },
  })
  const account = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: 'zernio_meter',
      platform: 'instagram',
      username: 'meter.co',
    },
  })
  accountRowId = account.id
  const conversation = await db.socialConversation.create({
    data: {
      workspaceId,
      accountId: account.id,
      zernioConversationId: 'conv_meter',
      platform: 'instagram',
    },
  })
  conversationId = conversation.id
  const post = await db.socialPost.create({
    data: {
      workspaceId,
      status: 'published',
      content: 'Bare post',
      idempotencyKey: `post_${crypto.randomUUID()}`,
    },
  })
  postId = post.id
})

beforeEach(() => {
  charges = []
  walletDown = false
  balanceOk = true
  balanceReason = undefined
  setSocialUsageWallet(fakeWallet)
  // `cloud` is the only mode that bills.
  setSocialClient({ mode: 'cloud', async request() { return {} } })
})

afterAll(() => {
  setSocialUsageWallet(null)
  setSocialClient(null)
})

async function newMessage(id: string, direction = 'outgoing') {
  return db.socialMessage.create({
    data: {
      workspaceId,
      conversationId,
      zernioMessageId: id,
      direction,
      platform: 'instagram',
      text: id,
      sentAt: new Date(),
    },
  })
}

describe('account pricing', () => {
  test('the bands are graduated and the 1–2 band carries the $12 credit', () => {
    expect(SOCIAL_ACCOUNT_BANDS.map((band) => band.upTo)).toEqual([2, 10, 100, 2000])
    // Two accounts at $6 are exactly the credit, so the band is free.
    expect(socialAccountMonthlyRawUsd(1)).toBe(0)
    expect(socialAccountMonthlyRawUsd(2)).toBe(0)
    // A third account leaves the free band: 3 × $6.
    expect(socialAccountMonthlyRawUsd(3)).toBe(18)
    expect(socialAccountMonthlyRawUsd(10)).toBe(60)
    expect(socialAccountMonthlyRawUsd(11)).toBe(33)
    expect(socialAccountMonthlyRawUsd(101)).toBe(101)
    expect(socialAccountBand(0).upTo).toBe(2)
    expect(socialAccountBand(500).perAccountUsd).toBe(1)
  })

  test('a part-month is prorated, and the markup is the shared 1.20', () => {
    expect(socialAccountMonthlyRawUsd(3, 0.5)).toBe(9)
    expect(socialBilledUsd(18)).toBe(21.6)
    expect(socialBilledUsd(0)).toBe(0)
  })

  test('connecting one more account is the marginal cost, not the whole bill', () => {
    // Leaving the 1–2 free band is expensive on purpose: the $12 credit goes
    // away, so the *third* account costs the full 3 × $6 — that is the number
    // the UI must show before someone connects it, not $6.
    expect(projectedConnectRawUsd(2, new Date('2026-10-01T00:00:00.000Z'))).toBe(18)
    // Above the first band the marginal account is just its own rate.
    expect(projectedConnectRawUsd(4, new Date('2026-10-01T00:00:00.000Z'))).toBe(6)
    // Mid-month it is the rest of the month only.
    const late = projectedConnectRawUsd(4, new Date('2026-10-16T12:00:00.000Z'))
    expect(late).toBeLessThan(6)
    expect(late).toBeGreaterThan(0)
  })
})

describe('social_dm', () => {
  test('the 10k allowance is free and the next DM bills $0.0001 × 1.20', async () => {
    // Prime the month with allowance-1 already-counted outbound messages.
    const seed = Array.from({ length: SOCIAL_DM_FREE_UNITS_PER_MONTH - 1 }, (_, index) =>
      messageNumber(index),
    )
    await db.socialMessage.createMany({ data: seed })

    const freeOne = await newMessage('dm_free_last')
    const free = await meterOutboundMessage(workspaceId, freeOne.id)
    expect(free.billed).toBe(false)
    expect(charges).toHaveLength(0)

    const billable = await newMessage('dm_first_billable')
    const billed = await meterOutboundMessage(workspaceId, billable.id)
    expect(billed.billed).toBe(true)
    expect(billed.rawUsd).toBeCloseTo(SOCIAL_DM_PROVIDER_USD, 10)
    expect(charges).toHaveLength(1)
    expect(charges[0]!.actionType).toBe('social_dm')
    expect(charges[0]!.billedUsd).toBeCloseTo(SOCIAL_DM_PROVIDER_USD * 1.2, 10)
    expect(charges[0]!.actionMetadata.freeUnitsThisMonth).toBe(SOCIAL_DM_FREE_UNITS_PER_MONTH)
  })

  test('the same message counted twice is one unit', async () => {
    const row = await newMessage('dm_twice')
    const first = await meterOutboundMessage(workspaceId, row.id)
    const second = await meterOutboundMessage(workspaceId, row.id)
    // Past the allowance now, so the first one does charge — the second must not.
    expect(first.billed).toBe(true)
    expect(second.billed).toBe(false)
    expect(charges).toHaveLength(1)
    const stored = await db.socialMessage.findUnique({ where: { id: row.id } })
    expect(stored.metered).toBe(true)
  })

  test('an incoming message is never billed', async () => {
    const row = await newMessage('dm_incoming', 'incoming')
    const result = await meterOutboundMessage(workspaceId, row.id)
    expect(result.billed).toBe(false)
    expect(charges).toHaveLength(0)
  })

  test('a wallet failure releases the claim so the sweep can retry', async () => {
    const row = await newMessage('dm_wallet_down')
    walletDown = true
    const result = await meterOutboundMessage(workspaceId, row.id)
    expect(result.billed).toBe(false)
    const afterFailure = await db.socialMessage.findUnique({ where: { id: row.id } })
    expect(afterFailure.metered).toBe(false)

    walletDown = false
    const retried = await meterOutboundMessage(workspaceId, row.id)
    expect(retried.billed).toBe(true)
    expect(charges).toHaveLength(1)
  })

  test('the sweep picks up an outgoing message nothing metered', async () => {
    const stale = await db.socialMessage.create({
      data: {
        workspaceId,
        conversationId,
        zernioMessageId: 'dm_stale',
        direction: 'outgoing',
        platform: 'instagram',
        text: 'stale',
        sentAt: new Date(Date.now() - 60 * 60_000),
      },
    })
    const swept = await sweepPendingSocialUsage(workspaceId, { limit: 50 })
    expect(swept.dms).toBeGreaterThanOrEqual(1)
    const stored = await db.socialMessage.findUnique({ where: { id: stale.id } })
    expect(stored.metered).toBe(true)
  })
})

describe('social_x_api', () => {
  async function xTarget(args: { platform?: string; content?: string; status?: string; postContent?: string }) {
    const post = await db.socialPost.create({
      data: {
        workspaceId,
        status: 'published',
        content: args.postContent ?? 'Hello world',
        idempotencyKey: `x_${crypto.randomUUID()}`,
      },
    })
    const account = await db.socialAccount.create({
      data: {
        workspaceId,
        profileId: (await db.socialProfile.findFirst({ where: { workspaceId } })).id,
        zernioAccountId: `zernio_${crypto.randomUUID().slice(0, 8)}`,
        platform: args.platform ?? 'x',
        username: `user_${crypto.randomUUID().slice(0, 8)}`,
      },
    })
    return db.socialPostTarget.create({
      data: {
        postId: post.id,
        accountId: account.id,
        platform: args.platform ?? 'x',
        customContent: args.content ?? null,
        status: args.status ?? 'published',
      },
    })
  }

  test('a plain X post is $0.015 and a post with a link is $0.20', async () => {
    const plain = await xTarget({})
    await meterXPost(workspaceId, plain.id)
    expect(charges).toHaveLength(1)
    expect(charges[0]!.rawUsd).toBeCloseTo(SOCIAL_X_POST_USD, 10)
    expect(charges[0]!.billedUsd).toBeCloseTo(SOCIAL_X_POST_USD * 1.2, 10)
    expect(charges[0]!.actionMetadata.withLink).toBe(false)

    const withLink = await xTarget({ postContent: 'Read this https://shogo.one/blog' })
    await meterXPost(workspaceId, withLink.id)
    expect(charges).toHaveLength(2)
    expect(charges[1]!.rawUsd).toBeCloseTo(SOCIAL_X_POST_WITH_LINK_USD, 10)
    expect(charges[1]!.actionMetadata.withLink).toBe(true)
    expect(contentHasLink('no link here')).toBe(false)
    expect(contentHasLink('https://example.com')).toBe(true)
  })

  test('only X is charged per post, and a failed leg is free', async () => {
    const instagram = await xTarget({ platform: 'instagram' })
    await meterXPost(workspaceId, instagram.id)
    expect(charges).toHaveLength(0)

    const failed = await xTarget({ status: 'failed' })
    await meterXPost(workspaceId, failed.id)
    expect(charges).toHaveLength(0)
  })

  test('a retried dispatch bills the leg once', async () => {
    const target = await xTarget({})
    await meterXPost(workspaceId, target.id)
    await meterXPost(workspaceId, target.id)
    expect(charges).toHaveLength(1)
    const stored = await db.socialPostTarget.findUnique({ where: { id: target.id } })
    expect(stored.meteredAt).not.toBeNull()
  })

  test('a broadcast projection counts only X, at the link price where it applies', () => {
    expect(projectedPublishRawUsd([])).toBe(0)
    expect(projectedPublishRawUsd([{ platform: 'instagram', content: 'hi' }])).toBe(0)
    expect(projectedPublishRawUsd([{ platform: 'x', content: 'hi' }])).toBeCloseTo(SOCIAL_X_POST_USD, 10)
    expect(
      projectedPublishRawUsd([
        { platform: 'x', content: 'see https://a.example' },
        { platform: 'x', content: 'plain' },
      ]),
    ).toBeCloseTo(SOCIAL_X_POST_WITH_LINK_USD + SOCIAL_X_POST_USD, 10)
  })
})

describe('wallet pre-flight', () => {
  test('a short wallet refuses the operation with the standard code', async () => {
    balanceOk = false
    balanceReason = 'overage_cap_reached'
    await expect(assertSocialBudget(workspaceId, 0.2)).rejects.toMatchObject({
      status: 402,
      code: 'overage_cap_reached',
    })
    balanceOk = true
    await expect(assertSocialBudget(workspaceId, 0.2)).resolves.toBeUndefined()
  })

  test('nothing is charged and nothing is refused off the cloud', async () => {
    // A desktop relays to the cloud, which is the side that bills.
    setSocialClient({ mode: 'relay', async request() { return {} } })
    await expect(assertSocialBudget(workspaceId, 100)).resolves.toBeUndefined()
    const row = await newMessage('dm_relay_mode')
    const result = await meterOutboundMessage(workspaceId, row.id)
    expect(result.billed).toBe(false)
    expect(charges).toHaveLength(0)
    const stored = await db.socialMessage.findUnique({ where: { id: row.id } })
    // Not claimed either: the cloud owns this row's charge, not the desktop.
    expect(stored.metered).toBe(false)
  })
})

describe('the usage summary', () => {
  test('reports the meter state a user needs to see', async () => {
    const summary = await socialUsageSummary(workspaceId)
    expect(summary.accounts).toBeGreaterThan(0)
    expect(summary.band.perAccountUsd).toBeGreaterThan(0)
    expect(summary.dms.freeUnitsPerMonth).toBe(SOCIAL_DM_FREE_UNITS_PER_MONTH)
    expect(summary.dms.freeRemaining).toBeGreaterThanOrEqual(0)
    expect(summary.x.postUsd).toBe(SOCIAL_X_POST_USD)
    expect(Array.isArray(summary.chargedThisMonth)).toBe(true)
    // Everything charged this month is inside the current period.
    const monthStart = startOfMonthUtc(new Date())
    expect(monthStart.getUTCDate()).toBe(1)
    expect(summary.chargedThisMonth.length).toBeGreaterThan(0)
  })
})
