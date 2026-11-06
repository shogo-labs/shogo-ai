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
    // The test stage builds a simulator/emulator binary per platform, and that
    // build is charged like any other — so the projection has to include it, or
    // preflight under-quotes what the release will cost.
    for (const build of input.builds) {
      raw += buildPriceUsd(TEST_BUILD_RESOURCE_CLASS[build.platform]) ?? 0
    }
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
  // A test build is a build: EAS ran a real worker for simulator/emulator build,
  // and the preflight projection already quotes it. It used to return 'skipped'
  // here, which is how the test stage ended up free while the customer was still
  // shown a cost for it. `native_test_run` covers the Maestro run and CI minutes.

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

/** A finished build younger than this may still be mid-flight through the webhook. */
export const NATIVE_METER_SWEEP_GRACE_MS = 10 * 60 * 1000

export interface MeterSweepResult {
  /** Claims reverted because the process died between the claim and the charge. */
  recovered: number
  retried: number
  metered: number
  unpriced: number
  failed: number
  /** Test runs that finished but never got charged (a crashed poller). */
  testRunsPending: number
}

/**
 * Close the gaps the webhook cannot: a delivery that was retried past us, a
 * process that died holding a claim, a finished build nobody billed.
 *
 * The webhook is the fast path and is allowed to be lossy — Expo's retry window
 * is not ours to rely on, and the poller only ever looks at `testing` releases.
 * So every pass re-walks three things that should not stay open:
 *
 * 1. **Stuck claims.** `meteredAt` is set *before* the wallet call; a crash in
 *    between leaves a row that `meterBuild` will refuse forever. Reset it after
 *    the grace window so the charge is retried rather than lost.
 * 2. **Finished but unmetered builds.** `meterBuild` is idempotent (it re-claims
 *    the row), so this is safe to call on every pass.
 * 3. **Unpriced rows.** They are never billed at a guess, so they accumulate
 *    until a human adds a price — one aggregate alert, not one per build.
 */
export async function sweepNativeMeters(opts: {
  now?: Date
  limit?: number
  mode?: ReturnType<typeof nativeReleaseMode>
} = {}): Promise<MeterSweepResult> {
  const result: MeterSweepResult = {
    recovered: 0,
    retried: 0,
    metered: 0,
    unpriced: 0,
    failed: 0,
    testRunsPending: 0,
  }
  const mode = opts.mode ?? nativeReleaseMode()
  if (mode !== 'cloud') return result

  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - NATIVE_METER_SWEEP_GRACE_MS)

  const stuck = await db.nativeBuild.findMany({
    where: { meterStatus: 'metering', meteredAt: { not: null }, updatedAt: { lt: cutoff } },
    select: { id: true },
    take: opts.limit ?? 50,
  })
  for (const row of stuck) {
    await db.nativeBuild.update({ where: { id: row.id }, data: { meteredAt: null, meterStatus: null } })
    result.recovered += 1
  }

  const pending = await db.nativeBuild.findMany({
    where: {
      status: 'finished',
      meteredAt: null,
      meterStatus: null,
      finishedAt: { lt: cutoff },
    },
    select: { easBuildId: true, release: { select: { workspaceId: true } } },
    take: opts.limit ?? 50,
  })
  for (const row of pending) {
    result.retried += 1
    const outcome = await meterBuild({
      easBuildId: row.easBuildId,
      memberId: 'native-meter-sweep',
      mode,
    })
    if (outcome === 'metered') result.metered += 1
    else if (outcome === 'unpriced') result.unpriced += 1
    else if (outcome === 'failed') result.failed += 1
  }

  const unpricedRows = await db.nativeBuild.count({ where: { meterStatus: 'unpriced' } })
  const testRunsPending = await db.nativeRelease.count({
    where: { testOutcome: 'passed', testMeteredAt: null, updatedAt: { lt: cutoff } },
  })
  result.unpriced = Math.max(result.unpriced, unpricedRows)
  result.testRunsPending = testRunsPending

  if (unpricedRows > 0 || testRunsPending > 0 || result.failed > 0) {
    await alertOps('native_meter_sweep', {
      unpricedBuilds: unpricedRows,
      testRunsPending,
      failedCharges: result.failed,
      recoveredClaims: result.recovered,
      retried: result.retried,
    })
  }

  return result
}

/**
 * The resource class the generated `shogo-test` profile pins, and therefore what
 * a test build is priced at.
 *
 * The workflow's build cannot be priced from EAS: `Build` exposes only
 * `resourceClassDisplayName`. So the class is decided here, pinned in the profile
 * the runner writes (`eas.json` → `build['shogo-test']`), and used by both the
 * projection and the meter — the same number quoted is the number charged.
 */
export const TEST_BUILD_RESOURCE_CLASS: Record<'ios' | 'android', BuildResourceClass> = {
  ios: 'IOS_MEDIUM',
  android: 'ANDROID_MEDIUM',
}

/** eas.json's own enum; a class outside it cannot be pinned in a profile. */
const EAS_JSON_RESOURCE_CLASSES = ['default', 'medium', 'large'] as const

/**
 * The pinned class as `eas.json` spells it (`IOS_MEDIUM` → `medium`).
 *
 * The runner writes the profile, but the API owns this number because the API is
 * what quotes and charges it — so the runner asks for it rather than keeping a
 * second copy that can drift. A class eas.json cannot express is a bug in the
 * table above, not something to send and hope for.
 */
export function easJsonResourceClass(): { ios: string; android: string } {
  const toShort = (cls: BuildResourceClass, platform: 'ios' | 'android'): string => {
    const short = cls.toLowerCase().replace(`${platform}_`, '')
    if (!(EAS_JSON_RESOURCE_CLASSES as readonly string[]).includes(short)) {
      throw new Error(
        `[native-release] ${cls} has no eas.json equivalent (${EAS_JSON_RESOURCE_CLASSES.join('|')}), so the generated profile cannot pin the class the meter prices.`,
      )
    }
    return short
  }
  return {
    ios: toShort(TEST_BUILD_RESOURCE_CLASS.ios, 'ios'),
    android: toShort(TEST_BUILD_RESOURCE_CLASS.android, 'android'),
  }
}

/** The raw USD a month's Updates MAU represents, past the included allowance. */
export function updateMauRawUsd(mau: number): number {
  if (!Number.isFinite(mau) || mau <= 0) return 0
  const billable = Math.max(0, Math.floor(mau) - NATIVE_UPDATE_INCLUDED_MAU)
  return Math.round(billable * NATIVE_UPDATE_MAU_USD * 1e6) / 1e6
}
