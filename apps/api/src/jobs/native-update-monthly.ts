// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `native_update_mau` — the monthly Updates meter.
 *
 * Expo charges per monthly active user for over-the-air updates, above each
 * plan's included allowance. We read the count from `AppInsights.totalUniqueUsers`
 * per app and bill the part past `NATIVE_UPDATE_INCLUDED_MAU`.
 *
 * The claim is the `NativeUsageMonth (nativeAppId, month)` row, the same shape
 * `SocialAccount.monthlyRateDebitedFor` gives the social meter: a month is billed
 * once, and a retried sweep lands on the existing row. Only `cloud` charges —
 * `byok` workspaces are billed by Expo directly.
 */

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'
import { easClientFor, nativeReleaseMode, resolveEasCredentials, type EasClient } from '../services/native-release/client'
import { readByokExpoToken } from '../services/native-release/credentials.service'
import { billedUsd, nativeWallet, updateMauRawUsd } from '../services/native-release/usage.service'

const db = prisma as any

/** `YYYY-MM` in UTC — the claim key. */
export function usageMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

async function readMau(client: EasClient, appId: string): Promise<number> {
  const data = await client.request<Record<string, any>>(
    `query Mau($appId: ID!) { app { byId(appId: $appId) { insights { totalUniqueUsers } } } }`,
    { appId },
  )
  const value = data?.app?.byId?.insights?.totalUniqueUsers
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

export interface NativeUpdateMonthlySummary {
  apps: number
  metered: number
  skipped: number
  rawUsd: number
}

export async function runNativeUpdateMonthly(now: Date = new Date()): Promise<NativeUpdateMonthlySummary> {
  const summary: NativeUpdateMonthlySummary = { apps: 0, metered: 0, skipped: 0, rawUsd: 0 }
  if (nativeReleaseMode() !== 'cloud') return summary

  const month = usageMonth(now)

  const lock = await withGlobalJobLock('native-update-monthly', async () => {
      const apps = await db.nativeApp.findMany({ where: { easAppId: { not: null } } })
      summary.apps = apps.length

      for (const app of apps) {
        const existing = await db.nativeUsageMonth.findUnique({
          where: { nativeAppId_month: { nativeAppId: app.id, month } },
        })
        if (existing?.meteredAt) {
          summary.skipped += 1
          continue
        }

        const credentials = await resolveEasCredentials({
          workspaceId: app.workspaceId,
          readByokToken: readByokExpoToken,
        })
        const mau = await readMau(easClientFor(credentials), app.easAppId)
        const raw = updateMauRawUsd(mau)

        const claim = await db.nativeUsageMonth.upsert({
          where: { nativeAppId_month: { nativeAppId: app.id, month } },
          create: { nativeAppId: app.id, month, mau },
          update: { mau },
        })
        if (claim.meteredAt) {
          summary.skipped += 1
          continue
        }

        if (raw <= 0) {
          continue
        }

        const result = await nativeWallet().consume({
          workspaceId: app.workspaceId,
          projectId: app.projectId,
          memberId: 'native-update-monthly',
          actionType: 'native_update_mau',
          rawUsd: raw,
          billedUsd: billedUsd(raw),
          actionMetadata: { month, mau, nativeAppId: app.id },
        })

        if (!result.success) {
          summary.skipped += 1
          continue
        }

        await db.nativeUsageMonth.update({
          where: { id: claim.id },
          data: { meteredAt: new Date() },
        })
        summary.metered += 1
        summary.rawUsd += raw
      }

      return summary
    })

  return lock.acquired ? lock.result : summary
}

/**
 * Schedule the monthly Updates meter. It re-checks every six hours and the
 * `NativeUsageMonth` claim makes it idempotent, so a restart mid-month, a missed
 * tick or a second region cannot bill a month twice. Nothing else calls the job,
 * so without this the meter would never run at all.
 */
export function startNativeUpdateMonthlyCron(intervalMs: number = 6 * 60 * 60 * 1000): void {
  const tick = (label: string) =>
    runNativeUpdateMonthly().catch((err) =>
      console.error(`[native-update-monthly] ${label} failed:`, err),
    )
  setTimeout(() => {
    void tick('initial run')
    setInterval(() => void tick('periodic run'), intervalMs)
  }, 5 * 60_000)
  console.log(
    `[native-update-monthly] cron scheduled (every ${Math.round(intervalMs / 3_600_000)}h)`,
  )
}
