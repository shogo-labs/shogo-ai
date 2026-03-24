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
  basic: Record<string, PriceTier>
  pro: Record<string, PriceTier>
  business: Record<string, PriceTier>
}

/**
 * Staging (Test) environment Stripe price IDs
 */
export const STRIPE_PRICES_STAGING: StripePriceConfig = {
  basic: {
    "50": {
      monthly: "price_1TEdhNAp5PDuxitpqtb0329O",
      annual: "price_1TEdhPAp5PDuxitpUFOWqjLl",
    },
  },
  pro: {
    "100": {
      monthly: "price_1SpirrAp5PDuxitpm9Pm4z1X",
      annual: "price_1SpirrAp5PDuxitpUl9L3qVQ",
    },
    "200": {
      monthly: "price_1SpjBnAp5PDuxitpHis4NfbV",
      annual: "price_1SpjBnAp5PDuxitpvIWwgFEs",
    },
    "400": {
      monthly: "price_1SpjBpAp5PDuxitpJCtpsTna",
      annual: "price_1SpjBpAp5PDuxitpzzR64YDU",
    },
    "800": {
      monthly: "price_1SpjBqAp5PDuxitpgLKdfN9X",
      annual: "price_1SpjBrAp5PDuxitp1AD0ajTp",
    },
    "1200": {
      monthly: "price_1SpjBtAp5PDuxitpKpnISjKm",
      annual: "price_1SpjBtAp5PDuxitpCFOxab9E",
    },
    "2000": {
      monthly: "price_1SpjBuAp5PDuxitpipUuwvnj",
      annual: "price_1SpjBvAp5PDuxitpG5h8BMWg",
    },
    "3000": {
      monthly: "price_1SpjBwAp5PDuxitpi7vEYfTZ",
      annual: "price_1SpjBwAp5PDuxitpC9fjIC3R",
    },
    "5000": {
      monthly: "price_1SpjByAp5PDuxitpp0yzdoyB",
      annual: "price_1SpjByAp5PDuxitpMzlfdZPw",
    },
    "7500": {
      monthly: "price_1SpjC0Ap5PDuxitpNhn15qlw",
      annual: "price_1SpjC0Ap5PDuxitpF4kD9Mnp",
    },
    "10000": {
      monthly: "price_1SpjC1Ap5PDuxitppZAvufp4",
      annual: "price_1SpjC2Ap5PDuxitp4tr0dhqJ",
    },
  },
  business: {
    "100": {
      monthly: "price_1TCofXAp5PDuxitpVKyf2Qvk",
      annual: "price_1TCofXAp5PDuxitpRBUjXMYy",
    },
    "200": {
      monthly: "price_1TCofYAp5PDuxitpcEhmEpHm",
      annual: "price_1TCofYAp5PDuxitpbexSUYcJ",
    },
    "400": {
      monthly: "price_1TCofZAp5PDuxitptGIni7hO",
      annual: "price_1TCofZAp5PDuxitpOLGJFlBn",
    },
    "800": {
      monthly: "price_1TCofZAp5PDuxitpjItkTGBO",
      annual: "price_1TCofaAp5PDuxitpU7WA0tNk",
    },
    "1200": {
      monthly: "price_1TCofaAp5PDuxitpWoRGmm1o",
      annual: "price_1TCofbAp5PDuxitpy0HFmr47",
    },
    "2000": {
      monthly: "price_1TCofbAp5PDuxitpFoQFkbTs",
      annual: "price_1TCofbAp5PDuxitpxRGSOwmw",
    },
    "3000": {
      monthly: "price_1TCofcAp5PDuxitpkXKesyL3",
      annual: "price_1TCofcAp5PDuxitpmK6XRxbx",
    },
    "5000": {
      monthly: "price_1TCofdAp5PDuxitp6Gh50Qgd",
      annual: "price_1TCofdAp5PDuxitpLxYeFckf",
    },
    "7500": {
      monthly: "price_1TCofdAp5PDuxitplXKUEZI1",
      annual: "price_1TCofeAp5PDuxitp9vl4UfEw",
    },
    "10000": {
      monthly: "price_1TCofeAp5PDuxitpeCSHtymi",
      annual: "price_1TCoffAp5PDuxitpcjd8mHoD",
    },
  },
}

/**
 * Production (Live) environment Stripe price IDs
 */
export const STRIPE_PRICES_PRODUCTION: StripePriceConfig = {
  basic: {
    "50": {
      monthly: "price_1TEdi4ADDMNd95Ggym2MWpEQ",
      annual: "price_1TEdi6ADDMNd95GgYZaoUHiQ",
    },
  },
  pro: {
    "100": {
      monthly: "price_1T6Ht1ADDMNd95GgzAqhbIJN",
      annual: "price_1T6Ht1ADDMNd95GgQYtajed3",
    },
    "200": {
      monthly: "price_1T6Ht2ADDMNd95Gg7QEN5DtS",
      annual: "price_1T6Ht2ADDMNd95GgueD8CeDi",
    },
    "400": {
      monthly: "price_1T6Ht2ADDMNd95GguxXoitCJ",
      annual: "price_1T6Ht3ADDMNd95Gg9V2yDELB",
    },
    "800": {
      monthly: "price_1T6Ht3ADDMNd95GgDjsDYHg3",
      annual: "price_1T6Ht3ADDMNd95Gg3JL67QTu",
    },
    "1200": {
      monthly: "price_1T6Ht4ADDMNd95GgbFWGI3gw",
      annual: "price_1T6Ht4ADDMNd95GgBgF3xmxZ",
    },
    "2000": {
      monthly: "price_1T6Ht5ADDMNd95GgEU7syDcX",
      annual: "price_1T6Ht5ADDMNd95GguMXj1iTk",
    },
    "3000": {
      monthly: "price_1T6Ht5ADDMNd95GgIBymcTvb",
      annual: "price_1T6Ht5ADDMNd95GgmbsYNOms",
    },
    "5000": {
      monthly: "price_1T6Ht6ADDMNd95GghPqlgO2p",
      annual: "price_1T6Ht6ADDMNd95GgHVDrV6JC",
    },
    "7500": {
      monthly: "price_1T6Ht6ADDMNd95GgFUj9A0tW",
      annual: "price_1T6Ht7ADDMNd95GgeR5Zy0YQ",
    },
    "10000": {
      monthly: "price_1T6Ht7ADDMNd95Ggq2iLjCay",
      annual: "price_1T6Ht7ADDMNd95Gg7d7BQwlZ",
    },
  },
  business: {
    "100": {
      monthly: "price_1TCofuADDMNd95GgosY40lHU",
      annual: "price_1TCofvADDMNd95Ggh5i7SgBy",
    },
    "200": {
      monthly: "price_1TCog3ADDMNd95GgrUYEU72G",
      annual: "price_1TCogFADDMNd95GgDVZvomnm",
    },
    "400": {
      monthly: "price_1TCogGADDMNd95Gg2KoA6wil",
      annual: "price_1TCogGADDMNd95GgwMjldSDl",
    },
    "800": {
      monthly: "price_1TCogGADDMNd95GgeCFnZBYO",
      annual: "price_1TCogHADDMNd95Gg72XoAZRM",
    },
    "1200": {
      monthly: "price_1TCogHADDMNd95Gg2VbK3x4d",
      annual: "price_1TCogIADDMNd95GgI5kL3q1g",
    },
    "2000": {
      monthly: "price_1TCogIADDMNd95GgJCgBrgjy",
      annual: "price_1TCogJADDMNd95GgnsQoFn1l",
    },
    "3000": {
      monthly: "price_1TCogJADDMNd95Ggolf50xp0",
      annual: "price_1TCogJADDMNd95Gg50S8Wdmg",
    },
    "5000": {
      monthly: "price_1TCogKADDMNd95GglPrqIWK8",
      annual: "price_1TCogKADDMNd95Gg0CT9w254",
    },
    "7500": {
      monthly: "price_1TCogKADDMNd95GgJvizgfeg",
      annual: "price_1TCogLADDMNd95GgnNeCD3dj",
    },
    "10000": {
      monthly: "price_1TCogLADDMNd95Gg8VpiOyTU",
      annual: "price_1TCogMADDMNd95GgdpAx0QoG",
    },
  },
}

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
  // Format: "basic", "pro", "pro_200", "business", "business_1200"
  const isBasicPlan = planId.startsWith("basic")
  const isBusinessPlan = planId.startsWith("business")
  const planType = isBasicPlan ? "basic" : isBusinessPlan ? "business" : "pro"

  // Extract credits from planId (e.g., "pro_200" -> "200", "pro" -> "100", "basic" -> "50")
  const parts = planId.split("_")
  const defaultCredits = isBasicPlan ? "50" : "100"
  const credits = parts.length > 1 ? parts[1] : defaultCredits

  const tierPrices = prices[planType]?.[credits]
  if (!tierPrices) {
    console.warn(`[Stripe] No price found for plan ${planId} (${planType}/${credits})`)
    return null
  }

  return tierPrices[billingInterval] || null
}
