/**
 * Billing End-to-End Integration Tests
 *
 * These tests hit the REAL Stripe test API to verify the billing integration.
 * Requires STRIPE_SECRET_KEY environment variable set to a test key (sk_test_*).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import Stripe from "stripe"
import { StripeBillingService } from "../stripe"
import { billingDomain } from "../domain"
import { NullPersistence } from "../../persistence"
import { createBackendRegistry, MemoryBackend } from "../../query"
import type { IEnvironment } from "../../environment/types"

// Skip tests if no Stripe key configured
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const shouldRun = STRIPE_SECRET_KEY?.startsWith("sk_test_")

// Price IDs from Stripe (created earlier)
const PRICE_IDS = {
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || "price_1SpirrAp5PDuxitpm9Pm4z1X",
    annual: process.env.STRIPE_PRICE_PRO_ANNUAL || "price_1SpirrAp5PDuxitpUl9L3qVQ",
  },
  business: {
    monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || "price_1SpirsAp5PDuxitpcmZZJmdp",
    annual: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || "price_1SpirsAp5PDuxitpmXAXZSU5",
  },
  enterprise: {
    monthly: "price_enterprise_monthly", // placeholder
    annual: "price_enterprise_annual", // placeholder
  },
}

// Reverse mapping from price ID to plan
const PRICE_TO_PLAN: Record<string, "pro" | "business" | "enterprise"> = {
  [PRICE_IDS.pro.monthly]: "pro",
  [PRICE_IDS.pro.annual]: "pro",
  [PRICE_IDS.business.monthly]: "business",
  [PRICE_IDS.business.annual]: "business",
}

describe.skipIf(!shouldRun)("Billing E2E Integration Tests", () => {
  let stripe: Stripe
  let billingService: StripeBillingService
  let store: any
  let testCustomerId: string | null = null

  beforeAll(async () => {
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not set")
    }

    // Initialize real Stripe client
    stripe = new Stripe(STRIPE_SECRET_KEY)

    // Initialize billing service with real Stripe
    billingService = new StripeBillingService(
      stripe,
      process.env.STRIPE_WEBHOOK_SECRET || "whsec_test",
      PRICE_IDS,
      PRICE_TO_PLAN
    )

    // Initialize billing domain store
    const backendRegistry = createBackendRegistry({
      default: "memory",
      backends: { memory: new MemoryBackend() },
    })

    const env: IEnvironment = {
      services: {
        persistence: new NullPersistence(),
        backendRegistry,
      },
      context: { schemaName: "billing" },
    }

    store = billingDomain.createStore(env)

    // Create a test customer for portal tests
    const customer = await stripe.customers.create({
      email: `test-${Date.now()}@example.com`,
      metadata: { workspaceId: `org-test-${Date.now()}` },
    })
    testCustomerId = customer.id
  })

  afterAll(async () => {
    // Cleanup: delete test customer
    if (testCustomerId) {
      try {
        await stripe.customers.del(testCustomerId)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  })

  describe("Stripe API Integration", () => {
    test("can create a checkout session with real Stripe API", async () => {
      const orgId = `org-checkout-${Date.now()}`

      const result = await billingService.createCheckoutSession(orgId, "pro", "monthly")

      expect(result.sessionId).toMatch(/^cs_test_/)
      expect(result.url).toContain("checkout.stripe.com")
    })

    test("can create checkout for business plan annual billing", async () => {
      const orgId = `org-business-${Date.now()}`

      const result = await billingService.createCheckoutSession(orgId, "business", "annual")

      expect(result.sessionId).toMatch(/^cs_test_/)
      expect(result.url).toBeDefined()
    })

    test("can get customer portal URL for existing customer", async () => {
      if (!testCustomerId) {
        throw new Error("Test customer not created")
      }

      // We need to get the portal URL using the customer ID
      // The service uses org ID, so we need to test the underlying functionality
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: testCustomerId,
        return_url: "https://example.com/return",
      })

      expect(portalSession.url).toContain("billing.stripe.com")
    })

    test("products exist in Stripe with correct metadata", async () => {
      const products = await stripe.products.list({ limit: 10, active: true })

      const proProduct = products.data.find((p) => p.metadata.plan_id === "pro")
      const businessProduct = products.data.find((p) => p.metadata.plan_id === "business")

      expect(proProduct).toBeDefined()
      expect(proProduct?.name).toBe("Pro")
      expect(proProduct?.metadata.monthly_credits).toBe("100")
      expect(proProduct?.metadata.daily_credits).toBe("5")

      expect(businessProduct).toBeDefined()
      expect(businessProduct?.name).toBe("Business")
    })

    test("prices exist with correct amounts", async () => {
      const proMonthlyPrice = await stripe.prices.retrieve(PRICE_IDS.pro.monthly)
      const proAnnualPrice = await stripe.prices.retrieve(PRICE_IDS.pro.annual)
      const businessMonthlyPrice = await stripe.prices.retrieve(PRICE_IDS.business.monthly)

      expect(proMonthlyPrice.unit_amount).toBe(2500) // $25.00
      expect(proMonthlyPrice.recurring?.interval).toBe("month")

      expect(proAnnualPrice.unit_amount).toBe(25000) // $250.00
      expect(proAnnualPrice.recurring?.interval).toBe("year")

      expect(businessMonthlyPrice.unit_amount).toBe(5000) // $50.00
    })
  })

  describe("Billing Domain Store Integration", () => {
    test("allocateMonthlyCredits creates ledger with 100 monthly + 5 daily", async () => {
      const orgId = `org-alloc-${Date.now()}`

      await store.allocateMonthlyCredits(orgId)

      const ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger).toBeDefined()
      expect(ledger.monthlyCredits).toBe(100)
      expect(ledger.dailyCredits).toBe(5)
      expect(ledger.rolloverCredits).toBe(0)
    })

    test("consumeCredits deducts from daily first", async () => {
      const orgId = `org-consume-${Date.now()}`
      const memberId = "member-test"

      // Setup ledger
      await store.allocateMonthlyCredits(orgId)

      // Consume 3 credits
      await store.consumeCredits(orgId, 3, memberId, "chat_message")

      const ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger.dailyCredits).toBe(2) // 5 - 3
      expect(ledger.monthlyCredits).toBe(100) // unchanged

      // Check usage event was created
      const events = store.usageEventCollection.recentForWorkspace(orgId)
      expect(events.length).toBe(1)
      expect(events[0].creditSource).toBe("daily")
      expect(events[0].creditCost).toBe(3)
    })

    test("consumeCredits falls back to monthly when daily exhausted", async () => {
      const orgId = `org-fallback-${Date.now()}`
      const memberId = "member-test"

      // Setup ledger
      await store.allocateMonthlyCredits(orgId)

      // Consume more than daily (7 credits = 5 daily + 2 monthly)
      await store.consumeCredits(orgId, 7, memberId, "code_generation")

      const ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger.dailyCredits).toBe(0)
      expect(ledger.monthlyCredits).toBe(98) // 100 - 2

      // Should have 2 usage events
      const events = store.usageEventCollection.recentForWorkspace(orgId)
      expect(events.length).toBe(2)
    })

    test("effectiveBalance returns 5 daily when lastDailyReset is stale", async () => {
      const orgId = `org-reset-${Date.now()}`
      const yesterday = Date.now() - 24 * 60 * 60 * 1000

      // Create ledger with depleted daily and stale reset
      store.creditLedgerCollection.add({
        id: crypto.randomUUID(),
        workspace: orgId,
        monthlyCredits: 50,
        dailyCredits: 0, // depleted
        rolloverCredits: 0,
        anniversaryDay: 15,
        lastDailyReset: yesterday, // stale
        lastMonthlyReset: Date.now(),
        createdAt: Date.now(),
      })

      const ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      const balance = ledger.effectiveBalance

      // Lazy reset should show 5 daily credits
      expect(balance.dailyCredits).toBe(5)
      expect(balance.monthlyCredits).toBe(50)
      expect(balance.total).toBe(55)
    })

    test("syncFromStripe creates subscription and allocates credits", async () => {
      const orgId = `org-sync-${Date.now()}`

      await store.syncFromStripe({
        subscriptionId: `sub_test_${Date.now()}`,
        workspaceId: orgId,
        customerId: `cus_test_${Date.now()}`,
        planId: "pro",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        isNew: true,
      })

      // Subscription should exist
      const subscriptions = store.subscriptionCollection.findByWorkspace(orgId)
      expect(subscriptions.length).toBe(1)
      expect(subscriptions[0].planId).toBe("pro")
      expect(subscriptions[0].isActive).toBe(true)

      // Credits should be allocated
      const ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger).toBeDefined()
      expect(ledger.monthlyCredits).toBe(100)
    })

    test("subscription.daysRemaining calculates correctly", async () => {
      const orgId = `org-days-${Date.now()}`
      const now = Date.now()
      const endIn10Days = now + 10 * 24 * 60 * 60 * 1000

      store.subscriptionCollection.add({
        id: crypto.randomUUID(),
        workspace: orgId,
        stripeSubscriptionId: "sub_days_test",
        stripeCustomerId: "cus_days_test",
        planId: "pro",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: now,
        currentPeriodEnd: endIn10Days,
        createdAt: now,
      })

      const subscription = store.subscriptionCollection.findByWorkspace(orgId)[0]
      expect(subscription.daysRemaining).toBe(10)
    })
  })

  describe("Credit Rollover Logic", () => {
    test("rollover credits accumulate for active subscriptions", async () => {
      const orgId = `org-rollover-${Date.now()}`

      // Create subscription
      store.subscriptionCollection.add({
        id: crypto.randomUUID(),
        workspace: orgId,
        stripeSubscriptionId: "sub_rollover_test",
        stripeCustomerId: "cus_rollover_test",
        planId: "pro",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      })

      // Allocate initial credits
      await store.allocateMonthlyCredits(orgId)

      // Use some credits (50 total = 5 daily + 45 monthly)
      await store.consumeCredits(orgId, 50, "member-1", "analysis")

      // Should have 55 monthly left (100 - 45, since 5 came from daily)
      let ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger.monthlyCredits).toBe(55)

      // Simulate month end - allocate new credits
      await store.allocateMonthlyCredits(orgId)

      // Should have 100 new monthly + 55 rollover (unused monthly from previous period)
      ledger = store.creditLedgerCollection.findByWorkspace(orgId)
      expect(ledger.monthlyCredits).toBe(100)
      expect(ledger.rolloverCredits).toBe(55)
    })
  })
})
