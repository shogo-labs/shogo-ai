// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regional Plan Pricing
 *
 * USD base prices consumed by the `/api/billing/regional-pricing` endpoint.
 * Mirrors the per-seat plan ladder in `apps/mobile/lib/billing-config.ts`
 * (`PLAN_PRICING`) so every plan key the client looks up (`basic`, `pro`,
 * `business`) resolves to a converted local-currency price — not just Basic.
 */

export type RegionalPlanId = 'free' | 'basic' | 'pro' | 'business'

export interface RegionalPlanUsd {
  monthly: number
  annual: number
}

export const REGIONAL_PLAN_USD_BASE: Record<RegionalPlanId, RegionalPlanUsd> = {
  free: { monthly: 0, annual: 0 },
  basic: { monthly: 8, annual: 80 },
  pro: { monthly: 20, annual: 200 },
  business: { monthly: 40, annual: 400 },
}

/**
 * Build the regional-pricing `plans` map by converting each USD base price
 * with the supplied `convert` function (local currency, already rounded per
 * the requesting currency's decimal places).
 */
export function buildRegionalPlans(
  convert: (usd: number) => number,
): Record<RegionalPlanId, RegionalPlanUsd> {
  const plans = {} as Record<RegionalPlanId, RegionalPlanUsd>
  for (const planId of Object.keys(REGIONAL_PLAN_USD_BASE) as RegionalPlanId[]) {
    const usd = REGIONAL_PLAN_USD_BASE[planId]
    plans[planId] = { monthly: convert(usd.monthly), annual: convert(usd.annual) }
  }
  return plans
}
