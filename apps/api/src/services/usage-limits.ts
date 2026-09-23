// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Balance-check contract shared by `billing.service.ts` and the local-mode
 * `billing-runtime.ts` seam. Kept dependency-free so the local API bundle can
 * import it without pulling in the Stripe-backed billing service.
 */

/**
 * Why a balance check failed, in enough detail for the HTTP layer to return
 * an accurate error code/message instead of the one-size-fits-all
 * `usage_limit_reached`:
 *
 *   - `entitlement_expired`: `usage_wallets.overageEnabled` is still `true`
 *     (the user turned on / has on-demand usage) but the paid entitlement
 *     backing it (Stripe subscription or grant) has lapsed. This is the
 *     "user sees on-demand enabled but still gets blocked" bug — see
 *     `resolveEffectivePlan`'s `paidTier` doc comment for why the column
 *     alone can't be trusted (incident 2026-08-06 / 2026-09-02).
 *   - `overage_cap_reached`: overage is genuinely active, but the
 *     workspace's own spending cap (`overageHardLimitUsd`) is exhausted.
 *   - `usage_limit_reached`: the generic case — no overage configured at
 *     all (or an uncapped/free wallet was never found), so the window is
 *     just the hard stop.
 */
export type UsageBlockReason = 'entitlement_expired' | 'overage_cap_reached' | 'usage_limit_reached'

export interface BalanceCheck {
  ok: boolean
  /** Only set when `ok` is `false`. */
  reason?: UsageBlockReason
}

/**
 * Map a balance-check failure reason to the HTTP error code/message the
 * client should see. Centralized so every route (chat, AI proxy, public
 * API, voice) reports the same accurate reason instead of the generic
 * "Enable usage-based pricing" message even when the user already has
 * on-demand usage turned on.
 */
export function usageLimitErrorPayload(reason: UsageBlockReason | undefined): { code: string; message: string } {
  switch (reason) {
    case 'entitlement_expired':
      return {
        code: 'entitlement_expired',
        message:
          "Your on-demand billing entitlement has expired. Reactivate your subscription or license key to continue using on-demand usage.",
      }
    case 'overage_cap_reached':
      return {
        code: 'overage_cap_reached',
        message:
          "You've reached your on-demand spending cap for this period. Raise your cap in Billing settings to continue.",
      }
    default:
      return {
        code: 'usage_limit_reached',
        message: "You've reached your usage limit. Enable usage-based pricing or upgrade your plan to continue.",
      }
  }
}
