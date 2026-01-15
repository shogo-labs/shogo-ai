/**
 * Billing API Routes Integration Tests
 *
 * Tests for authenticated billing API endpoints.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import { billingRoutes } from "../routes/billing"
import type { IBillingService, Subscription } from "@shogo/state-api"

// Mock subscription for testing
const mockSubscription: Subscription = {
  id: "sub-internal-id",
  workspaceId: "ws_test_123",
  stripeSubscriptionId: "sub_stripe_123",
  stripeCustomerId: "cus_stripe_456",
  planId: "pro",
  status: "active",
  billingInterval: "monthly",
  currentPeriodStart: Date.now(),
  currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
  createdAt: Date.now(),
}

// Mock billing service
const mockBillingService: IBillingService = {
  createCheckoutSession: mock(() =>
    Promise.resolve({
      sessionId: "cs_test_123",
      url: "https://checkout.stripe.com/cs_test_123",
    })
  ),
  getSubscription: mock(() => Promise.resolve(mockSubscription)),
  updateSubscription: mock(() => Promise.resolve({ ...mockSubscription, planId: "business" as const })),
  cancelSubscription: mock(() =>
    Promise.resolve({ ...mockSubscription, cancelAtPeriodEnd: true })
  ),
  getPortalUrl: mock(() =>
    Promise.resolve({ url: "https://billing.stripe.com/session/test" })
  ),
  processWebhookEvent: mock(() => Promise.resolve({ type: "subscription.created" as const, data: {} as any })),
}

// Mock billing store
const mockBillingStore = {
  subscriptionCollection: {
    findByWorkspace: mock(() => [mockSubscription]),
  },
  creditLedgerCollection: {
    findByWorkspace: mock(() => ({
      monthlyCredits: 100,
      dailyCredits: 5,
      rolloverCredits: 10,
      effectiveBalance: {
        dailyCredits: 5,
        monthlyCredits: 100,
        rolloverCredits: 10,
        total: 115,
      },
    })),
  },
}

// Mock auth context
const mockAuthContext = {
  userId: "user_123",
  workspaceId: "ws_test_123",
  isBillingAdmin: true,
}

// Type for custom context variables
type Variables = {
  auth: { userId: string; workspaceId: string; isBillingAdmin: boolean }
}

describe("Billing API Routes", () => {
  let app: Hono<{ Variables: Variables }>

  beforeEach(() => {
    // Reset mocks
    ;(mockBillingService.createCheckoutSession as any).mockClear()
    ;(mockBillingService.cancelSubscription as any).mockClear()
    ;(mockBillingService.getPortalUrl as any).mockClear()

    // Create fresh Hono app with billing routes
    app = new Hono<{ Variables: Variables }>()

    // Mock authentication middleware
    app.use("/api/billing/*", async (c, next) => {
      // Check for auth header (simulated)
      const authHeader = c.req.header("authorization")
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401)
      }

      // Check for billing admin permission (simulated)
      const isBillingAdmin = c.req.header("x-billing-admin") === "true"
      if (!isBillingAdmin) {
        return c.json({ error: "Forbidden: billing admin required" }, 403)
      }

      // Set auth context
      c.set("auth", mockAuthContext)
      await next()
    })

    // Mount billing routes
    app.route(
      "/api/billing",
      billingRoutes({
        billingService: mockBillingService,
        billingStore: mockBillingStore as any,
      })
    )
  })

  describe("POST /api/billing/checkout", () => {
    test("creates Stripe checkout session", async () => {
      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "true",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          planId: "pro",
          billingInterval: "monthly",
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.sessionId).toBe("cs_test_123")
      expect(data.url).toContain("checkout.stripe.com")
    })

    test("requires authentication", async () => {
      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: "pro", billingInterval: "monthly" }),
      })

      expect(res.status).toBe(401)
    })

    test("requires billing admin permission", async () => {
      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "false",
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: "pro", billingInterval: "monthly" }),
      })

      expect(res.status).toBe(403)
    })
  })

  describe("GET /api/billing/subscription", () => {
    test("returns current subscription and credits", async () => {
      const res = await app.request("/api/billing/subscription", {
        method: "GET",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "true",
        },
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.subscription).toBeDefined()
      expect(data.subscription.planId).toBe("pro")
      expect(data.credits).toBeDefined()
      expect(data.credits.total).toBe(115)
    })
  })

  describe("POST /api/billing/portal", () => {
    test("returns Stripe Customer Portal URL", async () => {
      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "true",
        },
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.url).toContain("billing.stripe.com")
    })
  })

  describe("POST /api/billing/cancel", () => {
    test("cancels subscription at period end", async () => {
      const res = await app.request("/api/billing/cancel", {
        method: "POST",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "true",
        },
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.subscription.cancelAtPeriodEnd).toBe(true)
    })
  })

  describe("Error handling", () => {
    test("returns BillingError format for invalid plan", async () => {
      ;(mockBillingService.createCheckoutSession as any).mockRejectedValueOnce({
        code: "invalid_plan",
        message: "Unknown plan: invalid",
      })

      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: {
          authorization: "Bearer test_token",
          "x-billing-admin": "true",
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: "invalid", billingInterval: "monthly" }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe("invalid_plan")
    })
  })
})
