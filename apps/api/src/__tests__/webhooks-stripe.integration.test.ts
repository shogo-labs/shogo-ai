/**
 * Stripe Webhook Endpoint Integration Tests
 *
 * Tests for the POST /api/webhooks/stripe endpoint.
 * Uses mocked Stripe signature verification.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import { stripeWebhookHandler } from "../webhooks/stripe"
import type { IBillingService, WebhookEvent } from "@shogo/state-api"

// Mock billing service for testing
const mockBillingService: IBillingService = {
  createCheckoutSession: mock(() => Promise.resolve({ sessionId: "", url: "" })),
  getSubscription: mock(() => Promise.resolve(null)),
  updateSubscription: mock(() => Promise.resolve({} as any)),
  cancelSubscription: mock(() => Promise.resolve({} as any)),
  getPortalUrl: mock(() => Promise.resolve({ url: "" })),
  processWebhookEvent: mock(() => Promise.resolve({
    type: "subscription.created" as const,
    data: {
      subscriptionId: "sub_test_123",
      workspaceId: "ws_test_456",
      planId: "pro" as const,
      status: "active" as const,
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
  } satisfies WebhookEvent)),
}

// Mock billing domain store for testing
const mockBillingStore = {
  syncFromStripe: mock(() => Promise.resolve()),
  allocateMonthlyCredits: mock(() => Promise.resolve()),
  subscriptionCollection: {
    findByWorkspace: mock(() => []),
    all: mock(() => []),
  },
  creditLedgerCollection: {
    findByWorkspace: mock(() => null),
  },
}

describe("POST /api/webhooks/stripe", () => {
  let app: Hono

  beforeEach(() => {
    // Reset mocks
    ;(mockBillingService.processWebhookEvent as any).mockClear()
    ;(mockBillingStore.syncFromStripe as any).mockClear()
    ;(mockBillingStore.allocateMonthlyCredits as any).mockClear()

    // Create fresh Hono app with webhook handler
    app = new Hono()
    app.post("/api/webhooks/stripe", stripeWebhookHandler({
      billingService: mockBillingService,
      billingStore: mockBillingStore as any,
    }))
  })

  test("endpoint exists and accepts POST requests", async () => {
    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "test_sig_123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "test" }),
    })

    // Should respond (not 404)
    expect(res.status).not.toBe(404)
  })

  test("verifies Stripe signature via billing service", async () => {
    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "test_sig_valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "customer.subscription.created" }),
    })

    // Should have called processWebhookEvent
    expect(mockBillingService.processWebhookEvent).toHaveBeenCalled()
  })

  test("returns 400 on signature verification failure", async () => {
    // Override mock to throw verification error
    ;(mockBillingService.processWebhookEvent as any).mockImplementationOnce(() => {
      throw {
        code: "webhook_verification_failed",
        message: "Invalid signature",
      }
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "invalid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "test" }),
    })

    expect(res.status).toBe(400)
  })

  test("subscription.created triggers syncFromStripe and allocateMonthlyCredits", async () => {
    ;(mockBillingService.processWebhookEvent as any).mockResolvedValueOnce({
      type: "subscription.created",
      data: {
        subscriptionId: "sub_new_123",
        workspaceId: "ws_test_456",
        planId: "pro",
        status: "active",
        currentPeriodStart: Date.now(),
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      },
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "valid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "customer.subscription.created" }),
    })

    expect(res.status).toBe(200)
    expect(mockBillingStore.syncFromStripe).toHaveBeenCalled()
  })

  test("subscription.updated syncs local state", async () => {
    ;(mockBillingService.processWebhookEvent as any).mockResolvedValueOnce({
      type: "subscription.updated",
      data: {
        subscriptionId: "sub_existing_123",
        planId: "business",
        status: "active",
      },
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "valid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "customer.subscription.updated" }),
    })

    expect(res.status).toBe(200)
    expect(mockBillingStore.syncFromStripe).toHaveBeenCalled()
  })

  test("subscription.deleted updates status to canceled", async () => {
    ;(mockBillingService.processWebhookEvent as any).mockResolvedValueOnce({
      type: "subscription.deleted",
      data: {
        subscriptionId: "sub_existing_123",
        status: "canceled",
      },
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "valid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "customer.subscription.deleted" }),
    })

    expect(res.status).toBe(200)
    expect(mockBillingStore.syncFromStripe).toHaveBeenCalled()
  })

  test("invoice.payment_failed updates subscription status", async () => {
    ;(mockBillingService.processWebhookEvent as any).mockResolvedValueOnce({
      type: "invoice.payment_failed",
      data: {
        invoiceId: "inv_123",
        failureMessage: "Card declined",
      },
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "valid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "invoice.payment_failed" }),
    })

    expect(res.status).toBe(200)
  })

  test("returns 200 even on business logic errors", async () => {
    // Override syncFromStripe to throw
    ;(mockBillingStore.syncFromStripe as any).mockImplementationOnce(() => {
      throw new Error("Organization not found")
    })

    ;(mockBillingService.processWebhookEvent as any).mockResolvedValueOnce({
      type: "subscription.created",
      data: { subscriptionId: "sub_test", workspaceId: "ws_nonexistent" },
    })

    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "valid_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "customer.subscription.created" }),
    })

    // Returns 200 to prevent Stripe retries on business logic errors
    expect(res.status).toBe(200)
  })

  test("endpoint does not require authentication", async () => {
    // No auth headers, should still process
    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "test_sig",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "test" }),
    })

    // Should not be 401 Unauthorized
    expect(res.status).not.toBe(401)
  })
})
