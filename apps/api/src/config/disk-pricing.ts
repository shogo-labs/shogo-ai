// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Disk add-on pricing (SHO-401).
 *
 * A workspace's tier includes a fixed amount of workspace drive (see
 * `workspaceDiskIncludedGiB`). Anything above that is a paid per-GiB-month
 * add-on, charged daily against the usage wallet — the same house pattern as
 * `published_hosting` and `voice_number_monthly`, so there is no new Stripe
 * price. Change the rate here; the daily job and the Settings panel both read
 * it.
 */

/** USD per GiB-month for workspace drive above the tier's included amount. */
export const DISK_ADDON_USD_PER_GIB_MONTH = 0.15

/** Round a USD amount to cents, matching the rest of the billing code. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 100) / 100
}

/**
 * The daily accrual for `addonGiB` of extra disk. Prorated by the number of
 * days in the month so a full month sums to `addonGiB × rate`.
 */
export function diskAddonDailyUsd(addonGiB: number, now: Date = new Date()): number {
  if (!(addonGiB > 0)) return 0
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  return roundUsd((addonGiB * DISK_ADDON_USD_PER_GIB_MONTH) / daysInMonth)
}

/** The monthly price of `addonGiB` of extra disk, for the Settings panel. */
export function diskAddonMonthlyUsd(addonGiB: number): number {
  if (!(addonGiB > 0)) return 0
  return roundUsd(addonGiB * DISK_ADDON_USD_PER_GIB_MONTH)
}
