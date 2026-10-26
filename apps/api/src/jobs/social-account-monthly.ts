// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `social_account_monthly` — the meter that charges connected social accounts.
 *
 * Zernio bills **per connected account**, graduated by how many you have
 * (`SOCIAL_ACCOUNT_BANDS`), prorated by the days the account was active. Two
 * consequences shape this job, and both of them are things a per-profile sweep
 * gets wrong:
 *
 * 1. **The band is decided by the cloud workspace's whole inventory.** A desktop
 *    with three local workspaces owns three profiles, but Zernio counts their
 *    accounts together — so the sweep aggregates every `SocialProfile` of the
 *    workspace (all `localWorkspaceId`s) before it picks a band. Banding per
 *    profile would put each of those three in the 1–2 band and undercharge by
 *    two thirds.
 * 2. **A profile that never syncs still bills.** Zernio charges for the accounts
 *    it holds, not for the rows we happened to write, so every profile is
 *    reconciled against `GET /accounts` before it is counted. An orphaned
 *    profile — a desktop that connected once and was never opened again — would
 *    otherwise hide a real charge and we would eat it.
 *
 * The watermark is `SocialAccount.monthlyRateDebitedFor` (the month it has been
 * charged for), and the whole body runs under
 * `withGlobalJobLock('social-account-monthly')` so exactly one region charges per
 * month: two regions racing the SELECT would both see the old watermark and both
 * debit.
 */

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { syncProfileAccounts } from '../services/social/accounts.service'
import {
  socialAccountBand,
  socialBilledUsd,
  socialMeteringEnabled,
  socialWallet,
  startOfMonthUtc,
  daysInMonthUtc,
  sweepPendingSocialUsage,
} from '../services/social/usage.service'

const db = prisma as any

export interface SocialAccountMonthlySummary {
  /** Workspaces that own at least one profile. */
  workspaces: number
  /** Active accounts counted across every profile of the charged workspaces. */
  accounts: number
  /** Accounts that exist only at Zernio and were adopted by the reconcile. */
  reconciled: number
  debited: number
  skipped: number
  failed: number
  rawUsd: number
  billedUsd: number
  period: Date
  lockSkipped?: boolean
}

/**
 * How much of the month an account was connected.
 *
 * An account connected on the 20th of a 30-day month is charged for 10 days;
 * anything connected before the month started is charged the whole month.
 */
export function activeFraction(
  account: { connectedAt?: Date | null },
  period: Date,
  now: Date = new Date(),
): number {
  const days = daysInMonthUtc(period)
  const monthEnd = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), days, 23, 59, 59, 999))
  const end = now < monthEnd ? now : monthEnd
  const connectedAt = account.connectedAt ? new Date(account.connectedAt) : period
  const start = connectedAt > period ? connectedAt : period
  if (start > end) return 0
  const activeDays = end.getUTCDate() - start.getUTCDate() + 1
  return Math.min(1, Math.max(0, activeDays / days))
}

export async function runSocialAccountMonthly(
  options: { now?: Date; reconcile?: boolean } = {},
): Promise<SocialAccountMonthlySummary> {
  const now = options.now ?? new Date()
  const period = startOfMonthUtc(now)
  const reconcile = options.reconcile !== false

  const summary: SocialAccountMonthlySummary = {
    workspaces: 0,
    accounts: 0,
    reconciled: 0,
    debited: 0,
    skipped: 0,
    failed: 0,
    rawUsd: 0,
    billedUsd: 0,
    period,
  }

  const lockResult = await withGlobalJobLock('social-account-monthly', async () => {
    // A desktop and a BYOK workspace never bill — Zernio bills them directly —
    // so there is nothing for this sweep to do outside the cloud. Checked inside
    // the lock only because the lock must stay this function's outermost
    // statement (see `scripts/check-multiregion-cron-locks.ts`).
    if (!socialMeteringEnabled()) return summary

    const profiles = await db.socialProfile.findMany({
      select: { id: true, workspaceId: true, zernioProfileId: true },
    })
    const workspaceIds = [...new Set(profiles.map((profile: any) => profile.workspaceId))] as string[]
    summary.workspaces = workspaceIds.length

    for (const workspaceId of workspaceIds) {
      try {
        const ownProfiles = profiles.filter((profile: any) => profile.workspaceId === workspaceId)

        if (reconcile) {
          for (const profile of ownProfiles) {
            const before = await db.socialAccount.count({ where: { profileId: profile.id, isActive: true } })
            try {
              await syncProfileAccounts(profile)
              const after = await db.socialAccount.count({ where: { profileId: profile.id, isActive: true } })
              summary.reconciled += Math.max(0, after - before)
            } catch (err) {
              // A provider blip must not silently shrink the bill: charge from
              // the rows we already have and report the failure.
              summary.failed += 1
              console.error('[SocialAccountMonthly] reconcile failed; charging from local rows', {
                workspaceId,
                profileId: profile.id,
                error: (err as any)?.message ?? err,
              })
            }
          }
        }

        const inventoryRows = await db.socialAccount.findMany({
          where: { workspaceId, isActive: true },
          select: { id: true, connectedAt: true, monthlyRateDebitedFor: true },
        })
        if (inventoryRows.length === 0) continue

        const due = inventoryRows.filter(
          (row: any) => !row.monthlyRateDebitedFor || new Date(row.monthlyRateDebitedFor) < period,
        )
        if (due.length === 0) continue
        summary.accounts = Math.max(summary.accounts, inventoryRows.length)

        /**
         * The workspace's bill is a property of its *whole* inventory, so it is
         * computed from every active account and then reduced by what the wallet
         * has already been charged for this action this month. Two reasons:
         * a connect mid-month must not re-price the closed part of the month, and
         * an account adopted by the reconcile late in the month must not be billed
         * as if it had been there since the 1st.
         */
        const band = socialAccountBand(inventoryRows.length)
        const fractionSum = inventoryRows.reduce(
          (sum: number, row: any) => sum + activeFraction(row, period, now),
          0,
        )
        const creditFraction = Math.min(1, fractionSum / inventoryRows.length)
        const targetRawUsd = Math.max(
          0,
          band.perAccountUsd * fractionSum - band.monthlyCreditUsd * creditFraction,
        )
        const alreadyCharged = await db.usageEvent.findMany({
          where: {
            workspaceId,
            actionType: 'social_account_monthly',
            createdAt: { gte: period },
          },
          select: { rawUsd: true },
        })
        const chargedSoFar = alreadyCharged.reduce(
          (sum: number, row: any) => sum + (row.rawUsd ?? 0),
          0,
        )
        const rawUsd = Math.round(Math.max(0, targetRawUsd - chargedSoFar) * 1_000_000) / 1_000_000

        if (rawUsd <= 0) {
          // The 1–2 band's $12 credit covers the whole bill (or this month is
          // already paid): advance the watermark without a zero-value usage event.
          await db.socialAccount.updateMany({
            where: { id: { in: due.map((row: any) => row.id) } },
            data: { monthlyRateDebitedFor: period },
          })
          summary.skipped += due.length
          continue
        }

        const billedUsd = socialBilledUsd(rawUsd)
        const result = await socialWallet().consume({
          workspaceId,
          projectId: null,
          memberId: 'social-account-monthly',
          actionType: 'social_account_monthly',
          rawUsd,
          billedUsd,
          actionMetadata: {
            periodStart: period.toISOString(),
            accounts: due.length,
            inventory: inventoryRows.length,
            band: band.upTo,
            perAccountUsd: band.perAccountUsd,
            monthlyCreditUsd: band.monthlyCreditUsd,
            activeAccountMonths: Number(fractionSum.toFixed(4)),
            chargedSoFarUsd: Number(chargedSoFar.toFixed(6)),
            targetRawUsd: Number(targetRawUsd.toFixed(6)),
            rawUsd,
            billedUsd,
          },
        })
        if (!result.success) {
          summary.failed += 1
          console.error('[SocialAccountMonthly] wallet refused the charge', {
            workspaceId,
            error: result.error,
          })
          continue
        }

        // Only now does the watermark move: a failed debit is retried next tick.
        await db.socialAccount.updateMany({
          where: { id: { in: due.map((row: any) => row.id) } },
          data: { monthlyRateDebitedFor: period },
        })
        summary.debited += due.length
        summary.rawUsd += rawUsd
        summary.billedUsd += billedUsd
      } catch (err) {
        summary.failed += 1
        console.error('[SocialAccountMonthly] workspace failed', {
          workspaceId,
          error: (err as any)?.message ?? err,
        })
      }
    }

    // The per-row meters are the live paths' job, but a claim released by a
    // wallet hiccup, or an echo that never arrived, would otherwise be lost.
    for (const workspaceId of workspaceIds) {
      try {
        await sweepPendingSocialUsage(workspaceId)
      } catch (err) {
        console.error('[SocialAccountMonthly] usage sweep failed', {
          workspaceId,
          error: (err as any)?.message ?? err,
        })
      }
    }

    return summary
  })

  if (lockResult.acquired) return lockResult.result
  return { ...summary, lockSkipped: true }
}

/**
 * Daily tick. Daily rather than monthly on purpose — a job that only runs on the
 * 1st is a job that misses February's short month after any deploy window, and
 * the watermark makes every extra tick a no-op.
 */
export function startSocialAccountMonthlyCron(intervalMs: number = 24 * 60 * 60 * 1000) {
  const tick = () =>
    runSocialAccountMonthly().catch((err) => {
      console.error('[SocialAccountMonthly] run failed:', err)
    })
  setTimeout(() => {
    void tick()
    setInterval(tick, intervalMs)
  }, 30_000)
  console.log(
    `[SocialAccountMonthly] social account meter scheduled (every ${Math.round(intervalMs / 3_600_000)}h)`,
  )
}
