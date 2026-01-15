/**
 * Billing Domain Integration Tests
 *
 * Tests for domain store with persistence backend.
 * Tests credit allocation, consumption, and rollover logic.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { billingDomain } from "../domain"
import { NullPersistence } from "../../persistence"
import { createBackendRegistry, MemoryBackend } from "../../query"
import type { IEnvironment } from "../../environment/types"

describe("billingDomain store operations", () => {
  let store: any
  let env: IEnvironment

  beforeEach(() => {
    const backendRegistry = createBackendRegistry({
      default: "memory",
      backends: {
        memory: new MemoryBackend(),
      },
    })

    env = {
      services: {
        persistence: new NullPersistence(),
        backendRegistry,
      },
      context: {
        schemaName: "billing",
      },
    }

    store = billingDomain.createStore(env)
  })

  describe("allocateMonthlyCredits", () => {
    test("creates CreditLedger with 100 monthly and 5 daily credits", async () => {
      const orgId = "org-test-123"

      await store.allocateMonthlyCredits(orgId)

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      expect(ledger).toBeDefined()
      expect(ledger.monthlyCredits).toBe(100)
      expect(ledger.dailyCredits).toBe(5)
    })

    test("sets anniversaryDay to current day of month", async () => {
      const orgId = "org-test-456"

      await store.allocateMonthlyCredits(orgId)

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      const today = new Date()
      expect(ledger.anniversaryDay).toBe(today.getUTCDate())
    })

    test("sets lastMonthlyReset to current timestamp", async () => {
      const orgId = "org-test-789"
      const before = Date.now()

      await store.allocateMonthlyCredits(orgId)

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      expect(ledger.lastMonthlyReset).toBeGreaterThanOrEqual(before)
    })
  })

  describe("effectiveBalance computed view", () => {
    test("returns daily and monthly credits when lastDailyReset is today", async () => {
      const orgId = "org-balance-test"

      // Create ledger with today's reset
      store.creditLedgerCollection.add({
        id: crypto.randomUUID(),
        organization: orgId,
        monthlyCredits: 50,
        dailyCredits: 3,
        rolloverCredits: 0,
        anniversaryDay: 1,
        lastDailyReset: Date.now(),
        lastMonthlyReset: Date.now(),
        createdAt: Date.now(),
      })

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      const balance = ledger.effectiveBalance

      expect(balance.dailyCredits).toBe(3)
      expect(balance.monthlyCredits).toBe(50)
    })

    test("resets daily credits to 5 if lastDailyReset is yesterday", async () => {
      const orgId = "org-reset-test"
      const yesterday = Date.now() - 24 * 60 * 60 * 1000

      // Create ledger with yesterday's reset and depleted daily
      store.creditLedgerCollection.add({
        id: crypto.randomUUID(),
        organization: orgId,
        monthlyCredits: 50,
        dailyCredits: 0,  // Depleted
        rolloverCredits: 0,
        anniversaryDay: 1,
        lastDailyReset: yesterday,
        lastMonthlyReset: Date.now(),
        createdAt: Date.now(),
      })

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      const balance = ledger.effectiveBalance

      // Should show 5 daily credits due to lazy reset
      expect(balance.dailyCredits).toBe(5)
      expect(balance.monthlyCredits).toBe(50)
    })
  })

  describe("consumeCredits", () => {
    test("deducts from daily credits first", async () => {
      const orgId = "org-consume-daily"
      const memberId = "member-123"

      // Setup ledger
      store.creditLedgerCollection.add({
        id: crypto.randomUUID(),
        organization: orgId,
        monthlyCredits: 100,
        dailyCredits: 5,
        rolloverCredits: 0,
        anniversaryDay: 1,
        lastDailyReset: Date.now(),
        lastMonthlyReset: Date.now(),
        createdAt: Date.now(),
      })

      await store.consumeCredits(orgId, 3, memberId, "chat_message")

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      expect(ledger.dailyCredits).toBe(2)
      expect(ledger.monthlyCredits).toBe(100) // Unchanged

      // Check usage event
      const events = store.usageEventCollection.all()
      expect(events.length).toBe(1)
      expect(events[0].creditSource).toBe("daily")
      expect(events[0].creditCost).toBe(3)
      expect(events[0].balanceBefore).toBe(5)
      expect(events[0].balanceAfter).toBe(2)
    })

    test("falls back to monthly when daily depleted", async () => {
      const orgId = "org-consume-monthly"
      const memberId = "member-456"

      // Setup ledger with depleted daily
      store.creditLedgerCollection.add({
        id: crypto.randomUUID(),
        organization: orgId,
        monthlyCredits: 100,
        dailyCredits: 2,  // Only 2 daily left
        rolloverCredits: 0,
        anniversaryDay: 1,
        lastDailyReset: Date.now(),
        lastMonthlyReset: Date.now(),
        createdAt: Date.now(),
      })

      await store.consumeCredits(orgId, 5, memberId, "code_generation")

      const ledger = store.creditLedgerCollection.all().find((l: any) => l.organization === orgId)
      expect(ledger.dailyCredits).toBe(0)
      expect(ledger.monthlyCredits).toBe(97) // 100 - 3 overflow

      // Should have 2 usage events (one for daily, one for monthly)
      const events = store.usageEventCollection.all()
      expect(events.length).toBe(2)
    })
  })

  describe("syncFromStripe", () => {
    test("creates Subscription entity from webhook data", async () => {
      const webhookData = {
        subscriptionId: "sub_test_123",
        organizationId: "org-sync-test",
        customerId: "cus_test_456",
        planId: "pro",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }

      await store.syncFromStripe(webhookData)

      const subscription = store.subscriptionCollection.all().find(
        (s: any) => s.stripeSubscriptionId === "sub_test_123"
      )
      expect(subscription).toBeDefined()
      expect(subscription.planId).toBe("pro")
      expect(subscription.status).toBe("active")
    })

    test("triggers credit allocation on new subscription", async () => {
      const webhookData = {
        subscriptionId: "sub_new_123",
        organizationId: "org-new-sub",
        customerId: "cus_new_456",
        planId: "business",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        isNew: true,
      }

      await store.syncFromStripe(webhookData)

      // Should have created both subscription and credit ledger
      const subscription = store.subscriptionCollection.all().find(
        (s: any) => s.stripeSubscriptionId === "sub_new_123"
      )
      expect(subscription).toBeDefined()

      const ledger = store.creditLedgerCollection.all().find(
        (l: any) => l.organization === "org-new-sub"
      )
      expect(ledger).toBeDefined()
      expect(ledger.monthlyCredits).toBe(100)
    })
  })

  describe("Collection queries", () => {
    test("subscriptionCollection.findByOrg returns subscriptions for organization", async () => {
      // Add subscriptions
      store.subscriptionCollection.add({
        id: crypto.randomUUID(),
        organization: "org-a",
        stripeSubscriptionId: "sub_a",
        stripeCustomerId: "cus_a",
        planId: "pro",
        status: "active",
        billingInterval: "monthly",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      })

      store.subscriptionCollection.add({
        id: crypto.randomUUID(),
        organization: "org-b",
        stripeSubscriptionId: "sub_b",
        stripeCustomerId: "cus_b",
        planId: "business",
        status: "active",
        billingInterval: "annual",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 365 * 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      })

      const orgASubscriptions = store.subscriptionCollection.findByOrg("org-a")
      expect(orgASubscriptions.length).toBe(1)
      expect(orgASubscriptions[0].stripeSubscriptionId).toBe("sub_a")
    })

    test("usageEventCollection.recentForOrg returns events for organization", async () => {
      const orgId = "org-usage-test"

      // Add usage events
      store.usageEventCollection.add({
        id: crypto.randomUUID(),
        organization: orgId,
        memberId: "member-1",
        actionType: "chat_message",
        creditCost: 1,
        creditSource: "daily",
        balanceBefore: 5,
        balanceAfter: 4,
        createdAt: Date.now(),
      })

      store.usageEventCollection.add({
        id: crypto.randomUUID(),
        organization: "other-org",
        memberId: "member-2",
        actionType: "chat_message",
        creditCost: 1,
        creditSource: "daily",
        balanceBefore: 5,
        balanceAfter: 4,
        createdAt: Date.now(),
      })

      const events = store.usageEventCollection.recentForOrg(orgId)
      expect(events.length).toBe(1)
      expect(events[0].organization).toBe(orgId)
    })
  })
})
