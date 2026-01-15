/**
 * Billing Environment Extension Tests
 *
 * Tests for extending IEnvironment with optional billing service.
 */

import { describe, test, expect } from "bun:test"
import type { IEnvironment } from "../types"
import type { IBillingService } from "../../billing/types"
import { NullPersistence } from "../../persistence"

describe("IEnvironment billing extension", () => {
  test("accepts optional billing property in services", () => {
    // Create a mock billing service
    const mockBillingService: IBillingService = {
      createCheckoutSession: async () => ({ sessionId: "", url: "" }),
      getSubscription: async () => null,
      updateSubscription: async () => ({} as any),
      cancelSubscription: async () => ({} as any),
      getPortalUrl: async () => ({ url: "" }),
      processWebhookEvent: async () => ({ type: "subscription.created", data: {} }),
    }

    // Create environment WITH billing service
    const envWithBilling: IEnvironment = {
      services: {
        persistence: new NullPersistence(),
        billing: mockBillingService,
      },
      context: {
        schemaName: "test-schema",
      },
    }

    expect(envWithBilling.services.billing).toBeDefined()
    expect(envWithBilling.services.billing).toBe(mockBillingService)
  })

  test("compiles without billing service (optional)", () => {
    // Create environment WITHOUT billing service
    const envWithoutBilling: IEnvironment = {
      services: {
        persistence: new NullPersistence(),
      },
      context: {
        schemaName: "test-schema",
      },
    }

    expect(envWithoutBilling.services.billing).toBeUndefined()
  })

  test("other services still work alongside billing", () => {
    const mockBillingService: IBillingService = {
      createCheckoutSession: async () => ({ sessionId: "", url: "" }),
      getSubscription: async () => null,
      updateSubscription: async () => ({} as any),
      cancelSubscription: async () => ({} as any),
      getPortalUrl: async () => ({ url: "" }),
      processWebhookEvent: async () => ({ type: "subscription.created", data: {} }),
    }

    const env: IEnvironment = {
      services: {
        persistence: new NullPersistence(),
        billing: mockBillingService,
      },
      context: {
        schemaName: "test-schema",
      },
    }

    // Both billing and persistence should be available
    expect(env.services.persistence).toBeDefined()
    expect(env.services.billing).toBeDefined()
  })
})
