// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P6 — `social-account-monthly` against a real SQLite database.
 *
 * The two properties this job exists for, and the ways it gets them wrong:
 *
 *   1. **One band per cloud workspace.** Zernio prices per account, so a desktop
 *      with three local workspaces must land in the 3–10 band, not in the free
 *      band three times. The fixture therefore spreads accounts across two
 *      profiles of the same workspace on purpose.
 *   2. **The watermark is the whole idempotence.** A daily tick must charge once
 *      per month, and a wallet that refuses must be retried rather than skipped.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { setSocialClient } = await import('../../services/social/client')
const { setSocialUsageWallet } = await import('../../services/social/usage.service')
const { activeFraction, runSocialAccountMonthly } = await import('../social-account-monthly')

const db = prisma as any

let charges: any[] = []
let walletDown = false
/** Accounts the fake provider reports for the next reconcile. */
let providerAccounts: any[] = []
let workspaceId = ''
let profileId = ''
let localProfileId = ''

const fakeWallet = {
  async consume(params: any) {
    if (walletDown) return { success: false, error: 'wallet offline' }
    charges.push(params)
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

async function addAccount(args: { profileId: string; platform: string; connectedAt?: Date }) {
  return db.socialAccount.create({
    data: {
      workspaceId,
      profileId: args.profileId,
      zernioAccountId: `za_${crypto.randomUUID().slice(0, 10)}`,
      platform: args.platform,
      username: `u_${crypto.randomUUID().slice(0, 8)}`,
      ...(args.connectedAt ? { connectedAt: args.connectedAt } : {}),
    },
  })
}

async function resetMonth() {
  await db.usageEvent.deleteMany({ where: { workspaceId } })
  await db.socialAccount.updateMany({ where: { workspaceId }, data: { monthlyRateDebitedFor: null } })
  charges = []
  walletDown = false
}

beforeAll(async () => {
  // Every tick below passes a fixed October `now`, while `connectedAt` (and the
  // rows reconcile adopts) default to the wall clock. Pin the wall clock before
  // those ticks, or an account "connected" after the tick prorates to 0 and the
  // suite starts failing the moment real time passes 2026-10-20T12:00Z.
  setSystemTime(new Date('2026-10-15T00:00:00.000Z'))
  const workspace = await db.workspace.create({
    data: { name: 'Monthly Co', slug: `monthly-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: 'zp_cloud',
      externalId: `ws_${workspaceId}`,
      name: 'Monthly Co',
    },
  })
  profileId = profile.id
  const localProfile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '11111111-1111-4111-8111-111111111111',
      zernioProfileId: 'zp_local_1',
      externalId: 'lws_11111111-1111-4111-8111-111111111111',
      name: 'Monthly Co (desktop)',
    },
  })
  localProfileId = localProfile.id
})

beforeEach(async () => {
  await db.socialPostTarget.deleteMany({ where: {} }).catch(() => {})
  await db.socialMessage.deleteMany({ where: { workspaceId } }).catch(() => {})
  providerAccounts = []
})

afterAll(() => {
  setSystemTime()
  setSocialUsageWallet(null)
  setSocialClient(null)
})

describe('the monthly account meter', () => {
  test('bands across every local scope of one workspace, not per profile', async () => {
    await resetMonth()
    // Two accounts on the cloud profile, one on the desktop's — three total, so
    // the workspace is in the 3–10 band even though each profile is in 1–2.
    await addAccount({ profileId, platform: 'instagram' })
    await addAccount({ profileId, platform: 'facebook' })
    await addAccount({ profileId: localProfileId, platform: 'tiktok' })
    setSocialClient({ mode: 'cloud', async request() { return { accounts: providerAccounts } } })
    setSocialUsageWallet(fakeWallet)

    const summary = await runSocialAccountMonthly({ now: new Date('2026-10-20T12:00:00.000Z'), reconcile: false })
    expect(summary.accounts).toBe(3)
    expect(summary.debited).toBe(3)
    expect(charges).toHaveLength(1)
    expect(charges[0]!.actionType).toBe('social_account_monthly')
    // 3 × $6, prorated to the part of October these accounts were live: they
    // were connected "now", so this is the remaining days of the month only.
    expect(charges[0]!.actionMetadata.inventory).toBe(3)
    expect(charges[0]!.actionMetadata.band).toBe(10)
    expect(charges[0]!.rawUsd).toBeLessThan(18)
    expect(charges[0]!.billedUsd).toBeCloseTo(charges[0]!.rawUsd * 1.2, 6)
  })

  test('a second tick in the same month charges nothing', async () => {
    const before = charges.length
    const summary = await runSocialAccountMonthly({ now: new Date('2026-10-21T12:00:00.000Z'), reconcile: false })
    expect(summary.debited).toBe(0)
    expect(charges).toHaveLength(before)
  })

  test('a wallet failure does not move the watermark, so the next tick retries', async () => {
    await resetMonth()
    walletDown = true
    setSocialClient({ mode: 'cloud', async request() { return { accounts: providerAccounts } } })
    setSocialUsageWallet(fakeWallet)
    const failed = await runSocialAccountMonthly({ now: new Date('2026-10-22T12:00:00.000Z'), reconcile: false })
    expect(failed.failed).toBeGreaterThan(0)
    expect(failed.debited).toBe(0)
    const stale = await db.socialAccount.count({ where: { workspaceId, monthlyRateDebitedFor: null } })
    expect(stale).toBe(3)

    walletDown = false
    const retried = await runSocialAccountMonthly({ now: new Date('2026-10-23T12:00:00.000Z'), reconcile: false })
    expect(retried.debited).toBe(3)
    expect(charges).toHaveLength(1)
  })

  test('the 1–2 band is covered by the $12 credit and charges nothing', async () => {
    await resetMonth()
    // Retire one of the three accounts so the workspace is back in the free band.
    const extra = await db.socialAccount.findFirst({
      where: { workspaceId, profileId: localProfileId },
    })
    await db.socialAccount.update({ where: { id: extra.id }, data: { isActive: false } })
    setSocialClient({ mode: 'cloud', async request() { return { accounts: providerAccounts } } })
    setSocialUsageWallet(fakeWallet)

    const summary = await runSocialAccountMonthly({ now: new Date('2026-10-24T12:00:00.000Z'), reconcile: false })
    expect(summary.accounts).toBe(2)
    expect(summary.debited).toBe(0)
    expect(summary.skipped).toBe(2)
    expect(charges).toHaveLength(0)
    // The watermark still advances, so the free band is not re-examined daily.
    const advanced = await db.socialAccount.count({ where: { workspaceId, monthlyRateDebitedFor: null } })
    expect(advanced).toBe(1) // only the retired account is still null
    await db.socialAccount.update({ where: { id: extra.id }, data: { isActive: true } })
  })

  test('an account that exists only at the provider is adopted and billed', async () => {
    await resetMonth()
    providerAccounts = [
      { id: 'za_provider_only', platform: 'instagram', username: 'orphan.ig' },
      { id: 'za_provider_only_2', platform: 'facebook', username: 'orphan.fb' },
    ]
    setSocialClient({
      mode: 'cloud',
      // Per-profile inventories, as Zernio actually has: the same provider
      // account id cannot live in two profiles, and a fake that reused one would
      // collapse the workspace's inventory and land it in the free band.
      async request(req: any) {
        const profileIdForCall = String(req?.query?.profileId ?? '')
        return {
          accounts: providerAccounts.map((account: any) => ({
            ...account,
            id: `${account.id}_${profileIdForCall}`,
            // Distinct handles per profile too: our own
            // `@@unique([workspaceId, platform, username])` is what would reject
            // the same handle twice inside one workspace, and this test is about
            // adoption, not about that constraint.
            username: `${account.username}_${String(profileIdForCall).slice(0, 6)}`,
          })),
        }
      },
    })
    setSocialUsageWallet(fakeWallet)

    const summary = await runSocialAccountMonthly({ now: new Date('2026-10-25T12:00:00.000Z') })
    const adopted = await db.socialAccount.findFirst({
      where: { zernioAccountId: 'za_provider_only_zp_cloud' },
    })
    expect(adopted).not.toBeNull()
    expect(adopted.workspaceId).toBe(workspaceId)
    expect(adopted.isActive).toBe(true)
    // The reconcile is provider-truth: the accounts it did not report are retired,
    // so the inventory is what Zernio holds, and that is what gets charged.
    const activeRows = await db.socialAccount.count({ where: { workspaceId, isActive: true } })
    expect(summary.accounts).toBe(activeRows)
    expect(charges.length).toBeGreaterThan(0)
  })
})

describe('proration', () => {
  test('a full month is 1, a mid-month connect is the rest of it, and a future one is 0', () => {
    const period = new Date('2026-10-01T00:00:00.000Z')
    const end = new Date('2026-10-31T23:59:59.999Z')
    expect(activeFraction({ connectedAt: new Date('2026-09-01T00:00:00.000Z') }, period, end)).toBe(1)
    expect(activeFraction({ connectedAt: new Date('2026-10-16T00:00:00.000Z') }, period, end)).toBeCloseTo(16 / 31, 6)
    expect(activeFraction({ connectedAt: new Date('2026-11-02T00:00:00.000Z') }, period, end)).toBe(0)
    // Mid-month the fraction runs to "now", not to the end of the month.
    const mid = new Date('2026-10-20T00:00:00.000Z')
    expect(activeFraction({ connectedAt: period }, period, mid)).toBeCloseTo(20 / 31, 6)
  })
})
