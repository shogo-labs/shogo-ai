// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-428 AC6 — the Solo Founder $50/mo cap warns before it bites.
 *
 * The offer sets `overageHardLimitUsd = 50` on enrollment, and
 * `evaluateUsageAlerts` is the only thing that tells the founder they are
 * approaching it. This pins the two thresholds the checkout disclosure
 * implies — 80% and 100% of the cap — to the cap value the offer actually
 * writes, so a change to either constant fails here.
 *
 *   bun test apps/api/src/__tests__/solo-founder-cap-alerts.test.ts
 */

import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import * as realNotificationService from '../services/notification.service'
import * as realEmailService from '../services/email.service'

const WS = 'ws-solo'

type Wallet = {
  monthlyIncludedAllocationUsd: number
  monthlyIncludedUsd: number
  overageAccumulatedUsd: number
  overageHardLimitUsd: number | null
  alertsSentThisPeriod: Record<string, boolean>
}

let wallet: Wallet | null = null

const notifications: any[] = []
const emails: any[] = []

const prismaStub = {
  usageWallet: {
    findUnique: async () => (wallet ? { ...wallet } : null),
    update: async (args: any) => {
      if (wallet) wallet = { ...wallet, ...args.data }
      return wallet ?? null
    },
  },
  workspace: {
    findUnique: async () => ({ name: 'Solo Founder Workspace' }),
  },
  member: {
    findMany: async () => [{ user: { email: 'founder@example.com' } }],
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub as any }))
mock.module('../services/notification.service', () => ({
  notifyWorkspaceBillingAdmins: async (_workspaceId: string, payload: any) => {
    notifications.push(payload)
    return { delivered: true }
  },
}))
mock.module('../services/email.service', () => ({
  sendApproachingLimitEmail: async (params: any) => {
    emails.push({ kind: 'approaching', ...params })
    return { success: true }
  },
  sendOverageChargedEmail: async () => ({ success: true }),
  sendPaymentReceiptEmail: async () => ({ success: true }),
  sendPaymentFailedEmail: async () => ({ success: true }),
  sendPaymentActionRequiredEmail: async () => ({ success: true }),
}))

afterAll(() => {
  mock.module('../services/notification.service', () => realNotificationService)
  mock.module('../services/email.service', () => realEmailService)
})

const { evaluateUsageAlerts } = await import('../services/billing-alerts.service')
const { SOLO_FOUNDER_OVERAGE_CAP_USD } = await import('../config/usage-plans')

beforeEach(() => {
  notifications.length = 0
  emails.length = 0
  wallet = {
    monthlyIncludedAllocationUsd: 20,
    monthlyIncludedUsd: 20,
    overageAccumulatedUsd: 0,
    overageHardLimitUsd: SOLO_FOUNDER_OVERAGE_CAP_USD,
    alertsSentThisPeriod: {},
  }
})

describe('AC6 the $50 cap warns at its two thresholds', () => {
  test('the offer cap is $50, so the first warning lands at $40 of overage', async () => {
    expect(SOLO_FOUNDER_OVERAGE_CAP_USD).toBe(50)
    wallet!.overageAccumulatedUsd = 40

    await evaluateUsageAlerts(WS)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('usage_threshold')
    expect(notifications[0].title).toContain('80%')
    expect(notifications[0].metadata).toMatchObject({
      limitLabel: 'spending cap',
      usedUsd: 40,
      limitUsd: 50,
      percentUsed: 80,
    })
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ usedUsd: '40.00', limitUsd: '50.00', percentUsed: '80' })
    expect(wallet!.alertsSentThisPeriod.approachingCap).toBe(true)
  })

  test('it does not repeat the 80% warning for the rest of the period', async () => {
    wallet!.overageAccumulatedUsd = 40
    await evaluateUsageAlerts(WS)
    wallet!.overageAccumulatedUsd = 45
    await evaluateUsageAlerts(WS)

    expect(notifications).toHaveLength(1)
    expect(emails).toHaveLength(1)
  })

  test('reaching the cap is its own, louder alert', async () => {
    wallet!.overageAccumulatedUsd = 40
    await evaluateUsageAlerts(WS)
    notifications.length = 0
    emails.length = 0

    wallet!.overageAccumulatedUsd = SOLO_FOUNDER_OVERAGE_CAP_USD
    await evaluateUsageAlerts(WS)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('spend_limit_reached')
    expect(notifications[0].title).toContain('Spending limit reached')
    expect(notifications[0].message).toContain('$50.00')
    expect(wallet!.alertsSentThisPeriod.capReached).toBe(true)
  })

  test('both thresholds can fire in the same period, in that order', async () => {
    wallet!.overageAccumulatedUsd = 40
    await evaluateUsageAlerts(WS)
    wallet!.overageAccumulatedUsd = 50
    await evaluateUsageAlerts(WS)

    expect(notifications.map((n) => n.type)).toEqual(['usage_threshold', 'spend_limit_reached'])
  })

  test('a workspace with no cap gets no cap alert — only the ledger and the cap decide', async () => {
    wallet!.overageHardLimitUsd = null
    wallet!.overageAccumulatedUsd = 500

    await evaluateUsageAlerts(WS)

    expect(notifications).toHaveLength(0)
    expect(wallet!.alertsSentThisPeriod).toEqual({})
  })
})
