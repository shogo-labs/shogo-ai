/**
 * Billing Types Tests
 *
 * Tests for IBillingService interface and domain types.
 * Validates type exports and method signatures.
 */

import { describe, test, expect } from "bun:test"
import type {
  IBillingService,
  PlanId,
  BillingInterval,
  SubscriptionStatus,
  CheckoutSessionResult,
  PortalSessionResult,
  Subscription,
  WebhookEvent,
  WebhookEventType,
  BillingError,
  BillingErrorCode,
  CreditAllocation,
} from "../types"

describe("IBillingService interface", () => {
  test("exports createCheckoutSession method signature", () => {
    // Type-level test: verify the interface shape compiles
    const mockService: IBillingService = {
      createCheckoutSession: async (workspaceId, planId, billingInterval) => ({
        sessionId: "cs_test_123",
        url: "https://checkout.stripe.com/cs_test_123",
      }),
      getSubscription: async () => null,
      updateSubscription: async () => ({} as any),
      cancelSubscription: async () => ({} as any),
      getPortalUrl: async () => ({ url: "" }),
      processWebhookEvent: async () => ({ type: "subscription.created" as const, data: {} as any }),
    }

    // Verify createCheckoutSession signature
    expect(typeof mockService.createCheckoutSession).toBe("function")
  })

  test("exports subscription management methods", () => {
    const mockService: IBillingService = {
      createCheckoutSession: async () => ({ sessionId: "", url: "" }),
      getSubscription: async (subscriptionId: string) => null,
      updateSubscription: async (subscriptionId: string, updates: { planId?: PlanId; billingInterval?: BillingInterval }) => ({} as any),
      cancelSubscription: async (subscriptionId: string) => ({} as any),
      getPortalUrl: async (workspaceId: string) => ({ url: "" }),
      processWebhookEvent: async () => ({ type: "subscription.created" as const, data: {} as any }),
    }

    expect(typeof mockService.getSubscription).toBe("function")
    expect(typeof mockService.updateSubscription).toBe("function")
    expect(typeof mockService.cancelSubscription).toBe("function")
    expect(typeof mockService.getPortalUrl).toBe("function")
  })
})

describe("Domain types", () => {
  test("PlanId type covers pro, business, enterprise", () => {
    const proPlan: PlanId = "pro"
    const businessPlan: PlanId = "business"
    const enterprisePlan: PlanId = "enterprise"

    expect(proPlan).toBe("pro")
    expect(businessPlan).toBe("business")
    expect(enterprisePlan).toBe("enterprise")
  })

  test("BillingInterval type covers monthly and annual", () => {
    const monthly: BillingInterval = "monthly"
    const annual: BillingInterval = "annual"

    expect(monthly).toBe("monthly")
    expect(annual).toBe("annual")
  })

  test("SubscriptionStatus type covers active, canceled, past_due, unpaid", () => {
    const active: SubscriptionStatus = "active"
    const canceled: SubscriptionStatus = "canceled"
    const pastDue: SubscriptionStatus = "past_due"
    const unpaid: SubscriptionStatus = "unpaid"

    expect(active).toBe("active")
    expect(canceled).toBe("canceled")
    expect(pastDue).toBe("past_due")
    expect(unpaid).toBe("unpaid")
  })
})

describe("WebhookEvent type", () => {
  test("covers subscription lifecycle events", () => {
    const created: WebhookEventType = "subscription.created"
    const updated: WebhookEventType = "subscription.updated"
    const deleted: WebhookEventType = "subscription.deleted"
    const paymentFailed: WebhookEventType = "invoice.payment_failed"

    expect(created).toBe("subscription.created")
    expect(updated).toBe("subscription.updated")
    expect(deleted).toBe("subscription.deleted")
    expect(paymentFailed).toBe("invoice.payment_failed")
  })
})

describe("BillingError type", () => {
  test("has code enum covering error cases", () => {
    const notFound: BillingErrorCode = "subscription_not_found"
    const paymentFailed: BillingErrorCode = "payment_failed"
    const invalidPlan: BillingErrorCode = "invalid_plan"
    const webhookFailed: BillingErrorCode = "webhook_verification_failed"

    expect(notFound).toBe("subscription_not_found")
    expect(paymentFailed).toBe("payment_failed")
    expect(invalidPlan).toBe("invalid_plan")
    expect(webhookFailed).toBe("webhook_verification_failed")
  })

  test("BillingError can be created with code and message", () => {
    const error: BillingError = {
      code: "subscription_not_found",
      message: "Subscription not found",
    }

    expect(error.code).toBe("subscription_not_found")
    expect(error.message).toBe("Subscription not found")
  })
})

describe("CreditAllocation type", () => {
  test("contains monthly and daily credit fields", () => {
    const allocation: CreditAllocation = {
      monthlyCredits: 100,
      dailyCredits: 5,
    }

    expect(allocation.monthlyCredits).toBe(100)
    expect(allocation.dailyCredits).toBe(5)
  })
})
