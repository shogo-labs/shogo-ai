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
 *   - `overage_payment_pending`: overage is active, but the current overage
 *     block is invoiced and unpaid (or due to be invoiced). Overage resumes
 *     once that invoice is paid.
 *   - `email_verification_required` / `account_review_required`: the account
 *     itself is held (a high-risk signup that has not verified, or one that
 *     verified and is still clustered). A held account gets no free allowance
 *     at all — see `lib/signup-trust.ts`. Paid tiers are never held.
 *   - `overage_requires_payment`: overage is on and the plan is paid, but the
 *     card has never been charged (a trialing subscription whose first invoice
 *     is $0). Overage starts after the first real payment.
 *   - `usage_limit_reached`: the generic case — no overage configured at
 *     all (or an uncapped/free wallet was never found), so the window is
 *     just the hard stop.
 */
export type UsageBlockReason =
  | 'entitlement_expired'
  | 'overage_cap_reached'
  | 'overage_payment_pending'
  | 'email_verification_required'
  | 'account_review_required'
  | 'overage_requires_payment'
  | 'usage_limit_reached'

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
    case 'overage_payment_pending':
      return {
        code: 'overage_payment_pending',
        message:
          "Your latest on-demand usage charge hasn't been paid yet. Pay or confirm the open invoice in Billing settings to continue.",
      }
    case 'email_verification_required':
      return {
        code: 'email_verification_required',
        message:
          'Verify your email to start using AI. Check your inbox for the verification link, or resend it from Settings.',
      }
    case 'account_review_required':
      return {
        code: 'account_review_required',
        message: 'Your account is under review. Contact support if you think this is a mistake.',
      }
    case 'overage_requires_payment':
      return {
        code: 'overage_requires_payment',
        message:
          "On-demand usage starts after your first payment. Your trial includes your plan's usage limits and promo credit — add or verify a payment method to enable on-demand usage now.",
      }
    default:
      return {
        code: 'usage_limit_reached',
        message: "You've reached your usage limit. Enable usage-based pricing or upgrade your plan to continue.",
      }
  }
}
