/**
 * Billing Re-export Tests
 *
 * Tests that billing exports are available from the main package entry point.
 */

import { describe, test, expect } from "bun:test"
import {
  // Types - from @shogo/state-api root
  type IBillingService,
  type PlanId,
  isBillingError,
  createBillingError,
  // Services
  StripeBillingService,
  // Domain
  BillingDomain,
  billingDomain,
} from "../index"

describe("Main state-api index re-exports billing module", () => {
  test("IBillingService type is available", () => {
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

  test("StripeBillingService class is available", () => {
    expect(StripeBillingService).toBeDefined()
  })

  test("BillingDomain scope is available", () => {
    expect(BillingDomain).toBeDefined()
  })

  test("billingDomain result is available", () => {
    expect(billingDomain).toBeDefined()
    expect(billingDomain.name).toBe("billing")
  })

  test("Error utilities are available", () => {
    const error = createBillingError("invalid_plan", "Test")
    expect(isBillingError(error)).toBe(true)
  })
})
