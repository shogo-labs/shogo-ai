// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stripe Price Configuration
 *
 * Staging/Test environment price IDs for all plan tiers.
 * These are the actual Stripe price IDs from the test environment.
 */

export interface PriceTier {
  monthly: string
  annual: string
}

export interface StripePriceConfig {
  pro: Record<string, PriceTier>
  business: Record<string, PriceTier>
}

const CREDIT_TIERS = ["100", "200", "400", "800", "1200", "2000", "3000", "5000", "7500", "10000"] as const
const PLAN_TYPES = ["pro", "business"] as const
const BILLING_INTERVALS = ["monthly", "annual"] as const

function getStripePriceEnvVar(
  environment: "staging" | "production",
  planType: (typeof PLAN_TYPES)[number],
  credits: string,
  interval: (typeof BILLING_INTERVALS)[number]
): string {
  return `STRIPE_PRICE_${environment.toUpperCase()}_${planType.toUpperCase()}_${credits}_${interval.toUpperCase()}`
}

function loadStripePrices(environment: "staging" | "production"): StripePriceConfig {
  const config: StripePriceConfig = {
    pro: {},
    business: {},
  }

  for (const planType of PLAN_TYPES) {
    for (const credits of CREDIT_TIERS) {
      config[planType][credits] = {
        monthly: process.env[getStripePriceEnvVar(environment, planType, credits, "monthly")] || "",
        annual: process.env[getStripePriceEnvVar(environment, planType, credits, "annual")] || "",
      }
    }
  }

  return config
}

export const STRIPE_PRICES_STAGING = loadStripePrices("staging")
export const STRIPE_PRICES_PRODUCTION = loadStripePrices("production")

/**
 * Get the appropriate price config based on environment
 */
export function getStripePrices(): StripePriceConfig {
  const isProduction = process.env.NODE_ENV === "production"
  return isProduction ? STRIPE_PRICES_PRODUCTION : STRIPE_PRICES_STAGING
}

/**
 * Get a specific price ID for a plan and interval
 *
 * @param planId - Plan ID in format "pro", "pro_200", "business", "business_1200", etc.
 * @param billingInterval - "monthly" or "annual"
 * @returns Stripe price ID or null if not found
 */
export function getPriceId(
  planId: string,
  billingInterval: "monthly" | "annual"
): string | null {
  const prices = getStripePrices()

  // Parse planId to get type and credits
  // Format: "pro", "pro_200", "business", "business_1200"
  const isBusinessPlan = planId.startsWith("business")
  const planType = isBusinessPlan ? "business" : "pro"

  // Extract credits from planId (e.g., "pro_200" -> "200", "pro" -> "100")
  const parts = planId.split("_")
  const credits = parts.length > 1 ? parts[1] : "100"

  const tierPrices = prices[planType]?.[credits]
  if (!tierPrices) {
    console.warn(`[Stripe] No price found for plan ${planId} (${planType}/${credits})`)
    return null
  }

  return tierPrices[billingInterval] || null
}
