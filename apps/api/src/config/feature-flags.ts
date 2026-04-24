// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lightweight, env-driven feature flags.
 *
 * Flags here are intentionally global booleans — we're not trying to build a
 * full targeting system. Each flag reads a single env var and defaults to a
 * safe value. This lets us stage a risky rollout (e.g. the Cursor-style
 * usage-based billing cutover) without branching the entire codebase.
 */

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null) return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

/**
 * Master switch for the Cursor-style dollar-based usage model
 * (see prisma migration 20260424000000_credits_to_usd).
 *
 * When `false` the billing service still runs on the new schema but reports
 * the legacy credit-parity copy back to clients for a graceful rollout.
 * When `true` the API, webhooks, and clients emit fully USD-denominated
 * values and overage is metered to Stripe.
 *
 * Default: enabled in non-production so staging QA gets the new behavior,
 * disabled in production until we flip the flag during rollout.
 */
export const USAGE_BASED_BILLING_ENABLED = envFlag(
  'USAGE_BASED_BILLING_ENABLED',
  process.env.NODE_ENV !== 'production',
)

/**
 * Whether the Stripe metered overage subscription item should be provisioned
 * and charged. Split out from the display flag so the rollout can enable UI
 * first, then flip overage billing on once the Stripe SKU is confirmed.
 */
export const USAGE_OVERAGE_METERING_ENABLED = envFlag(
  'USAGE_OVERAGE_METERING_ENABLED',
  process.env.NODE_ENV !== 'production',
)
