// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a native release costs, and the meters that charge it.
 *
 * Three meters, one `UsageEvent.actionType` each:
 *
 *   `native_build`        a flat rate per EAS build, keyed by the
 *                         `BuildResourceClass` EAS reports.
 *   `native_test_run`     $0.05 per Maestro job plus the workflow's CI minutes.
 *   `native_update_mau`   monthly, per Updates MAU, from `AppInsights`.
 *
 * Two rules hold everywhere here:
 *
 * 1. **Only the cloud charges.** `byok` means the workspace pays Expo directly,
 *    and `relay` means the cloud charges for the desktop. So every meter checks
 *    `nativeReleaseMode() === 'cloud'` first and otherwise does nothing.
 * 2. **An unpriced class is never charged.** Expo's public rate card prices
 *    `medium` and `large` only; `IOS_M_*`, `*_DEFAULT`, `LEGACY` and `LINUX_*`
 *    have no published rate. A build on one of those gets
 *    `meterStatus = 'unpriced'`, an ops alert, and no charge — deliberately not
 *    the medium rate, because guessing bills customers for a price we invented.
 *
 * The markup is `MARKUP_MULTIPLIER` (1.20); there is no native-specific constant.
 */

import { prisma } from '../../lib/prisma'
import { MARKUP_MULTIPLIER } from '../../lib/usage-cost'
import { checkUsageBalance, consumeUsage } from '../billing-runtime'
import { nativeReleaseMode } from './client'
import type { BuildResourceClass } from './eas-graphql'
import { alertOps } from './alerts'

const db = prisma as any

/**
 * Expo's published flat rate per build, sourced from `expo.dev/pricing.md`
 * ("Expo Build jobs", read 2026-11-04). Only rows that exist in that table are
 * here — anything absent must fail loudly rather than be billed at a guess.
 */
export const BUILD_PRICE_USD: Partial<Record<BuildResourceClass, number>> = {
  ANDROID_MEDIUM: 1,
  ANDROID_LARGE: 2,
  IOS_MEDIUM: 2,
  IOS_LARGE: 4,
}

/** The flat rate for a build, or `null` when Expo does not publish one. */
export function buildPriceUsd(resourceClass: string | null | undefined): number | null {
  if (!resourceClass) return null
  const price = BUILD_PRICE_USD[resourceClass as BuildResourceClass]
  return typeof price === 'number' ? price : null
}

/** Every class the meter currently cannot price. Derived, so a new row cannot be forgotten. */
export const UNPRICED_RESOURCE_CLASSES: BuildResourceClass[] = [
  'ANDROID_DEFAULT',
  'IOS_DEFAULT',
  'IOS_M_MEDIUM',
  'IOS_M_LARGE',
  'LEGACY',
  'LINUX_MEDIUM',
  'LINUX_LARGE',
]

/** Per Maestro job. `$0.05, plus CI/CD minute usage` on the published card. */
export const NATIVE_MAESTRO_RUN_USD = 0.05
/** CI/CD workflow minutes, from the same card. */
export const NATIVE_CI_LINUX_MEDIUM_PER_MIN_USD = 0.018
export const NATIVE_CI_MACOS_MEDIUM_PER_MIN_USD = 0.075
/**
 * Updates MAU. Expo's rate is tiered by plan and by volume; the Shogo account is
 * still on Free (so no overage pricing applies yet), so this encodes the first
 * paid tier of the cheapest plan that has one. Re-read `expo.dev/pricing.md` when
 * the account moves to a paid plan — the tiers above 200k MAUs are cheaper, and
 * billing the first tier is deliberately conservative until then.
 */
export const NATIVE_UPDATE_MAU_USD = 0.005
/** The first MAUs of the month are included on every paid plan. */
export const NATIVE_UPDATE_INCLUDED_MAU = 3_000

/** Charged cost for a raw provider cost. Always `raw × MARKUP_MULTIPLIER`. */
export function billedUsd(rawUsd: number): number {
  return Math.round(rawUsd * MARKUP_MULTIPLIER * 1e6) / 1e6
}

export interface NativeUsageWallet {
  consume: typeof consumeUsage
  checkBalance: typeof checkUsageBalance
}

let walletOverride: NativeUsageWallet | null = null

export function setNativeUsageWallet(wallet: NativeUsageWallet | null): void {
  walletOverride = wallet
}

export function nativeWallet(): NativeUsageWallet {
  return walletOverride ?? { consume: consumeUsage, checkBalance: checkUsageBalance }
}

export interface ProjectedReleaseInput {
  /** The builds the release will start, with the class we intend to request. */
  builds: { platform: 'ios' | 'android'; resourceClass: BuildResourceClass }[]
  /** A test stage costs one Maestro job plus its CI minutes. */
  hasTests: boolean
  testCiMinutes?: number
}

/**
 * What a release will cost *before* it starts, so preflight can refuse a release
 * the wallet cannot cover instead of starting builds and failing to charge them.
 */
export function projectedReleaseRawUsd(input: ProjectedReleaseInput): number {
  let raw = 0
  for (const build of input.builds) {
    raw += buildPriceUsd(build.resourceClass) ?? 0
  }
  if (input.hasTests) {
    raw += NATIVE_MAESTRO_RUN_USD
    raw += (input.testCiMinutes ?? NATIVE_DEFAULT_TEST_CI_MINUTES) * NATIVE_CI_MACOS_MEDIUM_PER_MIN_USD
  }
  return Math.round(raw * 1e6) / 1e6
}

/** A test stage is a simulator build plus a Maestro pass; 10 minutes is the estimate. */
export const NATIVE_DEFAULT_TEST_CI_MINUTES = 10

export type BuildMeterOutcome = 'metered' | 'unpriced' | 'skipped' | 'failed'

/**
 * Charge one build, exactly once.
 *
 * The `meteredAt` claim is what makes a redelivered webhook safe: the row is
 * flipped before the wallet is touched, and reverted if the charge fails so the
 * sweep can retry instead of losing the charge.
 */
export async function meterBuild(opts: {
  easBuildId: string
  memberId: string
  mode?: ReturnType<typeof nativeReleaseMode>
}): Promise<BuildMeterOutcome> {
  const mode = opts.mode ?? nativeReleaseMode()
  if (mode !== 'cloud') return 'skipped'

  const build = await db.nativeBuild.findUnique({
    where: { easBuildId: opts.easBuildId },
    include: { release: true },
  })
  if (!build) {
    // A build we have no row for is either a hand-started build on the Shogo
    // account or a lost `createBuild` response. Neither is safe to guess at.
    await alertOps('native_build_unknown', { easBuildId: opts.easBuildId })
    return 'failed'
  }
  if (build.meteredAt) return 'skipped'
  if (build.purpose === 'test') {
    // The test build is counted in `native_test_run`, not as a store build.
    return 'skipped'
  }

  const price = buildPriceUsd(build.resourceClass)
  if (price === null) {
    await db.nativeBuild.update({
      where: { id: build.id },
      data: { meterStatus: 'unpriced' },
    })
    await alertOps('native_build_unpriced', {
      easBuildId: opts.easBuildId,
      resourceClass: build.resourceClass ?? null,
      releaseId: build.releaseId,
    })
    return 'unpriced'
  }

  const claimed = await db.nativeBuild.updateMany({
    where: { id: build.id, meteredAt: null },
    data: { meteredAt: new Date(), meterStatus: 'metering' },
  })
  if (claimed.count === 0) return 'skipped'

  const billed = billedUsd(price)
  const result = await nativeWallet().consume({
    workspaceId: build.release.workspaceId,
    projectId: build.release.projectId,
    memberId: opts.memberId,
    actionType: 'native_build',
    rawUsd: price,
    billedUsd: billed,
    actionMetadata: {
      easBuildId: build.easBuildId,
      platform: build.platform,
      resourceClass: build.resourceClass,
      releaseId: build.releaseId,
    },
  })

  if (!result.success) {
    await db.nativeBuild.update({
      where: { id: build.id },
      data: { meteredAt: null, meterStatus: null },
    })
    return 'failed'
  }

  await db.nativeBuild.update({ where: { id: build.id }, data: { meterStatus: 'metered' } })
  return 'metered'
}

/**
 * Charge one Maestro/CI test run. Same claim shape as `meterBuild`, on the
 * release row (`testMeteredAt`) because a test stage is one workflow run.
 */
export async function meterTestRun(opts: {
  releaseId: string
  memberId: string
  ciMinutes: number
  mode?: ReturnType<typeof nativeReleaseMode>
}): Promise<'metered' | 'skipped' | 'failed'> {
  const mode = opts.mode ?? nativeReleaseMode()
  if (mode !== 'cloud') return 'skipped'

  const release = await db.nativeRelease.findUnique({ where: { id: opts.releaseId } })
  if (!release || release.testMeteredAt) return 'skipped'

  const claimed = await db.nativeRelease.updateMany({
    where: { id: opts.releaseId, testMeteredAt: null },
    data: { testMeteredAt: new Date() },
  })
  if (claimed.count === 0) return 'skipped'

  const raw =
    NATIVE_MAESTRO_RUN_USD + Math.max(0, opts.ciMinutes) * NATIVE_CI_MACOS_MEDIUM_PER_MIN_USD
  const result = await nativeWallet().consume({
    workspaceId: release.workspaceId,
    projectId: release.projectId,
    memberId: opts.memberId,
    actionType: 'native_test_run',
    rawUsd: Math.round(raw * 1e6) / 1e6,
    billedUsd: billedUsd(raw),
    actionMetadata: { releaseId: release.id, maestroRuns: 1, ciMinutes: opts.ciMinutes },
  })

  if (!result.success) {
    await db.nativeRelease.update({ where: { id: opts.releaseId }, data: { testMeteredAt: null } })
    return 'failed'
  }
  return 'metered'
}

/** The raw USD a month's Updates MAU represents, past the included allowance. */
export function updateMauRawUsd(mau: number): number {
  if (!Number.isFinite(mau) || mau <= 0) return 0
  const billable = Math.max(0, Math.floor(mau) - NATIVE_UPDATE_INCLUDED_MAU)
  return Math.round(billable * NATIVE_UPDATE_MAU_USD * 1e6) / 1e6
}
