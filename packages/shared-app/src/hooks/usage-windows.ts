// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side derivation of the rolling 5-hour / weekly usage windows from the
 * usage wallet.
 *
 * The server's `getUsageWindows()` is the source of truth, but it is only
 * fetched alongside the workspace-plan endpoint (on mount / subscription
 * refetch). The usage *wallet*, by contrast, is reloaded far more often (e.g.
 * `refetchUsageWallet()` runs after every completed chat message), and it
 * carries every input needed to recompute window utilization. Deriving the
 * windows from the wallet therefore lets the usage bars refresh live without
 * waiting for another workspace-plan round-trip.
 *
 * This mirrors the backend `rollWindow` lazy-reset semantics in
 * `apps/api/src/services/billing.service.ts` exactly:
 *   - A window with no start (or whose duration has fully elapsed) is treated
 *     as freshly reopened: 0 used, 0% utilization, no reset countdown.
 *   - An open window preserves its start/used and reports
 *     `utilization = min(1, used / limit)` and `resetsAt = start + duration`.
 *
 * Limits are passed in (typically taken from the authoritative server snapshot)
 * so grant/seat overrides are respected without re-deriving the plan ladder.
 */
import type { UsageWindows, UsageWindowView } from './useBillingData'

/** Mirrors the backend window durations (keep in sync). */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/** The window-relevant subset of the usage wallet. */
export interface WalletWindowFields {
  fiveHourWindowStart?: Date | string | number | null
  fiveHourUsedUsd?: number | null
  weeklyWindowStart?: Date | string | number | null
  weeklyUsedUsd?: number | null
}

/** Per-window limits; `null` means uncapped (enterprise). */
export interface WindowLimitsInput {
  fiveHourUsd: number | null
  weeklyUsd: number | null
}

interface RolledWindow {
  startMs: number
  used: number
  /** True when the stored window is still open (not reset this tick). */
  opened: boolean
}

function toMs(value: Date | string | number | null | undefined): number {
  if (value == null) return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return Date.parse(value)
}

function rollWindow(
  start: Date | string | number | null | undefined,
  used: number,
  nowMs: number,
  durationMs: number,
): RolledWindow {
  const startMs = toMs(start)
  if (Number.isNaN(startMs) || nowMs - startMs >= durationMs) {
    return { startMs: nowMs, used: 0, opened: false }
  }
  return { startMs, used, opened: true }
}

function buildView(
  kind: UsageWindowView['kind'],
  rolled: RolledWindow,
  limitUsd: number | null,
  durationMs: number,
): UsageWindowView {
  const usedUsd = rolled.opened ? rolled.used : 0
  return {
    kind,
    usedUsd,
    limitUsd,
    utilization: limitUsd != null && limitUsd > 0 ? Math.min(1, usedUsd / limitUsd) : 0,
    resetsAt: rolled.opened ? new Date(rolled.startMs + durationMs).toISOString() : null,
  }
}

/**
 * Derive both rolling windows from the wallet + authoritative limits. Returns
 * `undefined` when there is no wallet to derive from (callers should fall back
 * to the server snapshot in that case).
 */
export function deriveUsageWindows(opts: {
  wallet: WalletWindowFields | null | undefined
  limits: WindowLimitsInput
  now?: number
}): UsageWindows | undefined {
  const { wallet, limits } = opts
  if (!wallet) return undefined
  const now = opts.now ?? Date.now()
  const five = rollWindow(wallet.fiveHourWindowStart, wallet.fiveHourUsedUsd ?? 0, now, FIVE_HOUR_MS)
  const week = rollWindow(wallet.weeklyWindowStart, wallet.weeklyUsedUsd ?? 0, now, SEVEN_DAY_MS)
  return {
    fiveHour: buildView('five_hour', five, limits.fiveHourUsd, FIVE_HOUR_MS),
    weekly: buildView('weekly', week, limits.weeklyUsd, SEVEN_DAY_MS),
  }
}
