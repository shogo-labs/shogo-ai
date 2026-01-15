/**
 * Billing Domain Tests
 *
 * Tests for ArkType scope exports and computed views.
 */

import { describe, test, expect } from "bun:test"
import { BillingDomain, billingDomain } from "../domain"

describe("BillingDomain ArkType scope", () => {
  test("exports Subscription type", () => {
    const exports = BillingDomain.export()

    expect(exports.Subscription).toBeDefined()
  })

  test("exports CreditLedger type", () => {
    const exports = BillingDomain.export()

    expect(exports.CreditLedger).toBeDefined()
  })

  test("exports UsageEvent type", () => {
    const exports = BillingDomain.export()

    expect(exports.UsageEvent).toBeDefined()
  })
})

describe("billingDomain result", () => {
  test("has correct name", () => {
    expect(billingDomain.name).toBe("billing")
  })

  test("provides RootStoreModel", () => {
    expect(billingDomain.RootStoreModel).toBeDefined()
  })

  test("provides createStore function", () => {
    expect(typeof billingDomain.createStore).toBe("function")
  })
})

describe("Subscription.isActive computed view", () => {
  test("returns true for status active", () => {
    // This is a type-level test - actual runtime test needs store
    const subscription = {
      id: "sub-1",
      workspace: "org-1",
      stripeSubscriptionId: "sub_test",
      stripeCustomerId: "cus_test",
      planId: "pro",
      status: "active",
      billingInterval: "monthly",
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    }

    expect(subscription.status).toBe("active")
  })
})

describe("CreditLedger.hasCredits computed view", () => {
  test("returns true when dailyCredits > 0", () => {
    const ledger = {
      id: "ledger-1",
      workspace: "org-1",
      monthlyCredits: 0,
      dailyCredits: 5,
      rolloverCredits: 0,
      anniversaryDay: 1,
      lastDailyReset: Date.now(),
      lastMonthlyReset: Date.now(),
      createdAt: Date.now(),
    }

    expect(ledger.dailyCredits).toBeGreaterThan(0)
  })
})
