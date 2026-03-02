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

/**
 * Staging (Test) environment Stripe price IDs
 */
export const STRIPE_PRICES_STAGING: StripePriceConfig = {
  pro: {
    // 100 credits (base tier)
    "100": {
      monthly: "price_1SpirrAp5PDuxitpm9Pm4z1X",
      annual: "price_1SpirrAp5PDuxitpUl9L3qVQ",
    },
    // 200 credits
    "200": {
      monthly: "price_1SpjBnAp5PDuxitpHis4NfbV",
      annual: "price_1SpjBnAp5PDuxitpvIWwgFEs",
    },
    // 400 credits
    "400": {
      monthly: "price_1SpjBpAp5PDuxitpJCtpsTna",
      annual: "price_1SpjBpAp5PDuxitpzzR64YDU",
    },
    // 800 credits
    "800": {
      monthly: "price_1SpjBqAp5PDuxitpgLKdfN9X",
      annual: "price_1SpjBrAp5PDuxitp1AD0ajTp",
    },
    // 1200 credits
    "1200": {
      monthly: "price_1SpjBtAp5PDuxitpKpnISjKm",
      annual: "price_1SpjBtAp5PDuxitpCFOxab9E",
    },
    // 2000 credits
    "2000": {
      monthly: "price_1SpjBuAp5PDuxitpipUuwvnj",
      annual: "price_1SpjBvAp5PDuxitpG5h8BMWg",
    },
    // 3000 credits
    "3000": {
      monthly: "price_1SpjBwAp5PDuxitpi7vEYfTZ",
      annual: "price_1SpjBwAp5PDuxitpC9fjIC3R",
    },
    // 5000 credits
    "5000": {
      monthly: "price_1SpjByAp5PDuxitpp0yzdoyB",
      annual: "price_1SpjByAp5PDuxitpMzlfdZPw",
    },
    // 7500 credits
    "7500": {
      monthly: "price_1SpjC0Ap5PDuxitpNhn15qlw",
      annual: "price_1SpjC0Ap5PDuxitpF4kD9Mnp",
    },
    // 10000 credits
    "10000": {
      monthly: "price_1SpjC1Ap5PDuxitppZAvufp4",
      annual: "price_1SpjC2Ap5PDuxitp4tr0dhqJ",
    },
  },
  business: {
    // 100 credits (base tier)
    "100": {
      monthly: "price_1SpirsAp5PDuxitpcmZZJmdp",
      annual: "price_1SpirsAp5PDuxitpmXAXZSU5",
    },
    // 200 credits
    "200": {
      monthly: "price_1SpjCeAp5PDuxitp7f1ScwEA",
      annual: "price_1SpjCeAp5PDuxitpVAzpHrDj",
    },
    // 400 credits
    "400": {
      monthly: "price_1SpjCgAp5PDuxitpBTZgHXih",
      annual: "price_1SpjCgAp5PDuxitpZxmkTVyh",
    },
    // 800 credits
    "800": {
      monthly: "price_1SpjChAp5PDuxitp212JaviA",
      annual: "price_1SpjChAp5PDuxitp1iFQ409N",
    },
    // 1200 credits
    "1200": {
      monthly: "price_1SpjCjAp5PDuxitp565DeqqQ",
      annual: "price_1SpjCjAp5PDuxitpsLSXl5BR",
    },
    // 2000 credits
    "2000": {
      monthly: "price_1SpjClAp5PDuxitpjjuiMQOv",
      annual: "price_1SpjClAp5PDuxitpqzWeh49P",
    },
    // 3000 credits
    "3000": {
      monthly: "price_1SpjCmAp5PDuxitpKcHLb3PL",
      annual: "price_1SpjCnAp5PDuxitpZFCVPjl5",
    },
    // 5000 credits
    "5000": {
      monthly: "price_1SpjCoAp5PDuxitpYZFxNt4N",
      annual: "price_1SpjCoAp5PDuxitpAb5n998P",
    },
    // 7500 credits
    "7500": {
      monthly: "price_1SpjCpAp5PDuxitpfVLwYXH0",
      annual: "price_1SpjCqAp5PDuxitp8oij0uEc",
    },
    // 10000 credits
    "10000": {
      monthly: "price_1SpjCrAp5PDuxitp6howYVqp",
      annual: "price_1SpjCrAp5PDuxitpHoGfWj3y",
    },
  },
}

/**
 * Production (Live) environment Stripe price IDs
 */
export const STRIPE_PRICES_PRODUCTION: StripePriceConfig = {
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
      monthly: "price_1T6Ht8ADDMNd95GgxYjA5in7",
      annual: "price_1T6Ht8ADDMNd95Gg2TpR4RID",
    },
    "200": {
      monthly: "price_1T6Ht8ADDMNd95GgV75HO6V4",
      annual: "price_1T6Ht9ADDMNd95Ggs6W4yvLe",
    },
    "400": {
      monthly: "price_1T6Ht9ADDMNd95GgmG6mar5e",
      annual: "price_1T6Ht9ADDMNd95GgEW6xKleZ",
    },
    "800": {
      monthly: "price_1T6Ht9ADDMNd95GgXvnlLAs0",
      annual: "price_1T6HtAADDMNd95GgD20TQf5x",
    },
    "1200": {
      monthly: "price_1T6HtAADDMNd95GgNhp3uNmx",
      annual: "price_1T6HtAADDMNd95Ggqpz1rpdB",
    },
    "2000": {
      monthly: "price_1T6HtBADDMNd95GgK8nYezfe",
      annual: "price_1T6HtBADDMNd95Ggf0oiGJTA",
    },
    "3000": {
      monthly: "price_1T6HtBADDMNd95GgzvcDk3WM",
      annual: "price_1T6HtCADDMNd95GgeZi4Ewde",
    },
    "5000": {
      monthly: "price_1T6HtCADDMNd95Ggv46uIYEL",
      annual: "price_1T6HtCADDMNd95Gg6GbPIRLf",
    },
    "7500": {
      monthly: "price_1T6HtDADDMNd95Gg0wF7h4nz",
      annual: "price_1T6HtDADDMNd95GgM0w7xFrn",
    },
    "10000": {
      monthly: "price_1T6HtDADDMNd95GgzvaI59KW",
      annual: "price_1T6HtDADDMNd95GgBRY5GWKk",
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
