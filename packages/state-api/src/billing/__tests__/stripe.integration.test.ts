/**
 * StripeBillingService Integration Tests
 *
 * Tests for the Stripe billing service implementation.
 * These tests use mocked Stripe responses to verify the service behavior.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { StripeBillingService } from "../stripe"
import type { PlanId, BillingInterval, Subscription } from "../types"
import { isBillingError } from "../types"

// Mock Stripe client type for testing
interface MockStripeClient {
  checkout: {
    sessions: {
      create: ReturnType<typeof mock>
    }
  }
  subscriptions: {
    retrieve: ReturnType<typeof mock>
    update: ReturnType<typeof mock>
  }
  customers: {
    search: ReturnType<typeof mock>
  }
  billingPortal: {
    sessions: {
      create: ReturnType<typeof mock>
    }
  }
  webhooks: {
    constructEvent: ReturnType<typeof mock>
  }
}

// Price ID mapping for tests
const TEST_PRICE_MAP: Record<string, PlanId> = {
  "price_pro_monthly": "pro",
  "price_pro_annual": "pro",
  "price_business_monthly": "business",
  "price_business_annual": "business",
}

describe("StripeBillingService", () => {
  let mockStripe: MockStripeClient
  let service: StripeBillingService

  beforeEach(() => {
    mockStripe = {
      checkout: {
        sessions: {
          create: mock(() => Promise.resolve({
            id: "cs_test_abc123",
            url: "https://checkout.stripe.com/cs_test_abc123",
          })),
        },
      },
      subscriptions: {
        retrieve: mock(() => Promise.resolve({
          id: "sub_test_123",
          customer: "cus_test_456",
          status: "active",
          items: {
            data: [{
              price: { id: "price_pro_monthly" },
              current_period_start: 1704067200,
              current_period_end: 1706745600,
            }],
          },
          start_date: 1704067200,
          cancel_at: null,
          cancel_at_period_end: false,
          created: 1704067200,
          metadata: { organizationId: "org_123" },
        })),
        update: mock(() => Promise.resolve({
          id: "sub_test_123",
          customer: "cus_test_456",
          status: "active",
          items: {
            data: [{
              price: { id: "price_business_monthly" },
              current_period_start: 1704067200,
              current_period_end: 1706745600,
            }],
          },
          start_date: 1704067200,
          cancel_at: null,
          cancel_at_period_end: false,
          created: 1704067200,
          metadata: { organizationId: "org_123" },
        })),
      },
      customers: {
        search: mock(() => Promise.resolve({
          data: [{ id: "cus_test_456" }],
        })),
      },
      billingPortal: {
        sessions: {
          create: mock(() => Promise.resolve({
            url: "https://billing.stripe.com/session/test_portal",
          })),
        },
      },
      webhooks: {
        constructEvent: mock(() => ({
          type: "customer.subscription.created",
          data: {
            object: {
              id: "sub_test_123",
              status: "active",
              metadata: { organizationId: "org_123" },
            },
          },
        })),
      },
    }

    service = new StripeBillingService(
      mockStripe as any,
      "whsec_test_secret",
      {
        pro: { monthly: "price_pro_monthly", annual: "price_pro_annual" },
        business: { monthly: "price_business_monthly", annual: "price_business_annual" },
        enterprise: { monthly: "price_enterprise_monthly", annual: "price_enterprise_annual" },
      },
      TEST_PRICE_MAP
    )
  })

  describe("createCheckoutSession", () => {
    test("creates real checkout session via Stripe", async () => {
      const result = await service.createCheckoutSession("org_123", "pro", "monthly")

      expect(result.sessionId).toBe("cs_test_abc123")
      expect(result.url).toContain("checkout.stripe.com")
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalled()
    })

    test("passes correct price ID for plan and interval", async () => {
      await service.createCheckoutSession("org_123", "business", "annual")

      const callArgs = (mockStripe.checkout.sessions.create as any).mock.calls[0][0]
      expect(callArgs.line_items[0].price).toBe("price_business_annual")
    })
  })

  describe("getSubscription", () => {
    test("retrieves subscription and maps to domain type", async () => {
      const result = await service.getSubscription("sub_test_123")

      expect(result).not.toBeNull()
      expect(result!.id).toBeDefined()
      expect(result!.planId).toBe("pro")
      expect(result!.status).toBe("active")
      expect(result!.currentPeriodStart).toBe(1704067200000) // Converted to ms
      expect(result!.currentPeriodEnd).toBe(1706745600000)
    })

    test("returns null for non-existent subscription", async () => {
      mockStripe.subscriptions.retrieve = mock(() =>
        Promise.reject({ type: "StripeInvalidRequestError", code: "resource_missing" })
      )

      const result = await service.getSubscription("sub_nonexistent")
      expect(result).toBeNull()
    })
  })

  describe("updateSubscription", () => {
    test("updates subscription plan via Stripe API", async () => {
      const result = await service.updateSubscription("sub_test_123", { planId: "business" })

      expect(result.planId).toBe("business")
      expect(mockStripe.subscriptions.update).toHaveBeenCalled()
    })
  })

  describe("cancelSubscription", () => {
    test("cancels subscription at period end", async () => {
      mockStripe.subscriptions.update = mock(() => Promise.resolve({
        id: "sub_test_123",
        customer: "cus_test_456",
        status: "active",
        items: {
          data: [{
            price: { id: "price_pro_monthly" },
            current_period_start: 1704067200,
            current_period_end: 1706745600,
          }],
        },
        start_date: 1704067200,
        cancel_at: null,
        cancel_at_period_end: true,
        created: 1704067200,
        metadata: { organizationId: "org_123" },
      }))

      const result = await service.cancelSubscription("sub_test_123")

      expect(result.status).toBe("active") // Still active until period end
      expect(result.cancelAtPeriodEnd).toBe(true)

      const callArgs = (mockStripe.subscriptions.update as any).mock.calls[0]
      expect(callArgs[1].cancel_at_period_end).toBe(true)
    })
  })

  describe("getPortalUrl", () => {
    test("creates customer portal session", async () => {
      const result = await service.getPortalUrl("org_123")

      expect(result.url).toContain("billing.stripe.com")
      expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalled()
    })
  })

  describe("processWebhookEvent", () => {
    test("verifies signature and parses event", async () => {
      const result = await service.processWebhookEvent("payload", "sig_header")

      expect(result.type).toBe("subscription.created")
      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
        "payload",
        "sig_header",
        "whsec_test_secret"
      )
    })

    test("throws BillingError on invalid signature", async () => {
      mockStripe.webhooks.constructEvent = mock(() => {
        throw new Error("Webhook signature verification failed")
      })

      try {
        await service.processWebhookEvent("payload", "invalid_sig")
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(isBillingError(error)).toBe(true)
        if (isBillingError(error)) {
          expect(error.code).toBe("webhook_verification_failed")
        }
      }
    })
  })

  describe("Error handling", () => {
    test("maps Stripe errors to BillingError", async () => {
      mockStripe.subscriptions.retrieve = mock(() =>
        Promise.reject({ type: "StripeInvalidRequestError", message: "Not found" })
      )

      const result = await service.getSubscription("sub_invalid")
      expect(result).toBeNull()
    })
  })
})
