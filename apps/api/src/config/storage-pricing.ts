// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage (S3) pricing (SHO-423).
 *
 * A workspace's instance tier includes a fixed amount of storage
 * (`INSTANCE_SIZES[tier].storageLimitBytes`, the allowance). Every billable byte
 * above that is charged per GB-month, accrued daily against the usage wallet —
 * the same house pattern as `disk_addon`, `published_hosting` and
 * `voice_number_monthly`, so there is no new Stripe price. Change the rate here;
 * the daily job, the Settings panel and the super-admin view all read it.
 *
 * Rollout is `shadow` first (`STORAGE_BILLING_MODE`): the daily job computes and
 * stores `chargedUsd` but never calls `consumeUsage`, so Russell can compare a
 * few days of real numbers before money moves.
 */

const BYTES_PER_GB = 1024 ** 3

/**
 * USD per GB-month of billable storage above the tier allowance.
 *
 * Unset pending Russell's number (see the card thread). 0.15 matches the other
 * storage-shaped rates in the repo (`PUBLISHED_PRICING.dbGBMonth`,
 * `DISK_ADDON_USD_PER_GIB_MONTH`), which keeps the first shadow numbers
 * comparable. Shadow mode means this is a projection only.
 */
export const STORAGE_USD_PER_GB_MONTH = 0.15

/** `shadow` computes and records the charge but never debits a wallet. */
export type StorageBillingMode = 'shadow' | 'enforce'

/**
 * `STORAGE_BILLING_MODE=shadow|enforce`, default `shadow`. Anything unrecognised
 * falls back to the safe mode rather than erroring: a typo in a K8s overlay must
 * not start charging customers.
 */
export function storageBillingMode(): StorageBillingMode {
  return process.env.STORAGE_BILLING_MODE === 'enforce' ? 'enforce' : 'shadow'
}

/** Round a USD amount to 6dp — the precision `consumeUsage` records. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

/**
 * Billable GB-months above the allowance for one day, prorated by the number of
 * days in that day's month so a full month sums to exactly the over-allowance
 * GB-months.
 */
export function storageDayGbMonths(
  billableBytes: number,
  allowanceBytes: number,
  day: Date = new Date(),
): number {
  const overBytes = Math.max(0, billableBytes - allowanceBytes)
  if (overBytes <= 0) return 0
  const daysInMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate()
  return overBytes / BYTES_PER_GB / daysInMonth
}

/** The USD accrued by one day of billable storage above the allowance. */
export function storageDailyUsd(
  billableBytes: number,
  allowanceBytes: number,
  day: Date = new Date(),
): number {
  return roundUsd(storageDayGbMonths(billableBytes, allowanceBytes, day) * STORAGE_USD_PER_GB_MONTH)
}

/** Bytes as GB (GiB, matching `INSTANCE_SIZES` and the rest of the repo). */
export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB
}
