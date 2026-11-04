// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published-app pricing (SHO-308 §9).
 *
 * Published apps are billed for real: an hourly job turns each environment's
 * `PublishedUsageMinute` rows into one `consumeUsage` call per environment per
 * hour with `actionType: "published_hosting"`. These are the rates that call
 * uses. All values are USD.
 *
 * Russell sets the numbers before prod billing goes live — they are deliberately
 * in one file so that is a one-line change, not a hunt.
 */

import type { PublishedSize } from '../lib/published-scale'

export interface PublishedPricing {
  /** USD per pod-second, by size tier. */
  podSecond: Record<PublishedSize, number>
  /** USD per GB-month of Postgres storage. */
  dbGBMonth: number
  /** Flat USD per environment-month for the database (0 = storage-only). */
  dbFlatMonth: number
  /** USD per GB of egress. */
  egressGB: number
  /** USD per GB-month of retained container images. */
  imageGBMonth: number
}

export const PUBLISHED_PRICING: PublishedPricing = {
  // ~$0.015/pod-hour for S, ~$0.03 for M, ~$0.06 for L.
  podSecond: {
    s: 0.0000042,
    m: 0.0000083,
    l: 0.0000167,
  },
  dbGBMonth: 0.15,
  dbFlatMonth: 0,
  egressGB: 0.01,
  imageGBMonth: 0.1,
}

export interface PublishedUsageInput {
  /** Pod-seconds consumed, by size tier. */
  podSeconds: Partial<Record<PublishedSize, number>>
  dbStorageBytes?: number
  egressBytes?: number
  /** Fraction of a month the environment existed (1 = the whole month). */
  monthFraction?: number
}

export interface PublishedUsageCost {
  podUsd: number
  dbUsd: number
  egressUsd: number
  totalUsd: number
}

const BYTES_PER_GB = 1024 ** 3

/**
 * Cost of one metering window. Pure so the hourly job, the dashboard's
 * projection and the tests all agree on the arithmetic.
 */
export function computePublishedCost(
  input: PublishedUsageInput,
  pricing: PublishedPricing = PUBLISHED_PRICING,
): PublishedUsageCost {
  let podUsd = 0
  for (const size of Object.keys(input.podSeconds) as PublishedSize[]) {
    const seconds = input.podSeconds[size] ?? 0
    podUsd += seconds * (pricing.podSecond[size] ?? 0)
  }

  const monthFraction = input.monthFraction ?? 1
  const dbGb = (input.dbStorageBytes ?? 0) / BYTES_PER_GB
  const dbUsd = (dbGb * pricing.dbGBMonth + pricing.dbFlatMonth) * monthFraction

  const egressGb = (input.egressBytes ?? 0) / BYTES_PER_GB
  const egressUsd = egressGb * pricing.egressGB

  return {
    podUsd,
    dbUsd,
    egressUsd,
    totalUsd: podUsd + dbUsd + egressUsd,
  }
}

/** Round to 6dp — the precision `consumeUsage` records. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
