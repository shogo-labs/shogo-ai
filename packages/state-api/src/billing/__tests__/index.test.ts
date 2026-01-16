/**
 * Billing Index Exports Tests
 *
 * Tests that all billing exports are available from the index.
 */

import { describe, test, expect } from "bun:test"
import {
  // Types
  type IBillingService,
  type PlanId,
  type BillingInterval,
  type SubscriptionStatus,
  type CheckoutSessionResult,
  type PortalSessionResult,
  type Subscription,
  type WebhookEvent,
  type BillingError,
  isBillingError,
  createBillingError,
  // Services
  StripeBillingService,
  // Domain
  BillingDomain,
  billingDomain,
} from "../index"

describe("Billing index exports", () => {
  describe("Type exports", () => {
    test("exports IBillingService interface", () => {
      // Type-level test - if this compiles, the export works
      const mockService: IBillingService = {
        createCheckoutSession: async () => ({ sessionId: "", url: "" }),
        getSubscription: async () => null,
        updateSubscription: async () => ({} as any),
        cancelSubscription: async () => ({} as any),
        getPortalUrl: async () => ({ url: "" }),
        processWebhookEvent: async () => ({ type: "subscription.created", data: {} }),
      }
      expect(mockService).toBeDefined()
    })

    test("exports domain types", () => {
      const planId: PlanId = "pro"
      const interval: BillingInterval = "monthly"
      const status: SubscriptionStatus = "active"

      expect(planId).toBe("pro")
      expect(interval).toBe("monthly")
      expect(status).toBe("active")
    })

    test("exports error utilities", () => {
      expect(typeof isBillingError).toBe("function")
      expect(typeof createBillingError).toBe("function")

      const error = createBillingError("invalid_plan", "Test error")
      expect(isBillingError(error)).toBe(true)
    })
  })

  describe("Service exports", () => {
    test("exports StripeBillingService class", () => {
      expect(StripeBillingService).toBeDefined()
      expect(typeof StripeBillingService).toBe("function") // Classes are functions
    })
  })

  describe("Domain exports", () => {
    test("exports BillingDomain ArkType scope", () => {
      expect(BillingDomain).toBeDefined()
      expect(typeof BillingDomain.export).toBe("function")
    })

    test("exports billingDomain result", () => {
      expect(billingDomain).toBeDefined()
      expect(billingDomain.name).toBe("billing")
      expect(typeof billingDomain.createStore).toBe("function")
    })
  })
})
