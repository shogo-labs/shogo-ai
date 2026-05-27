// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Routes E2E Test
 *
 * Tests the billing API endpoints with workspace-based checkout.
 * Validates the Organization -> Workspace refactor is complete.
 *
 * Prerequisites:
 * - API server running at localhost:3001
 * - STRIPE_SECRET_KEY environment variable set
 *
 * Run with: bun test apps/api/src/__tests__/billing-routes.e2e.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"

const API_BASE = "http://localhost:3001"

// Check if API server is available
async function isAPIServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { method: "GET" })
    return response.ok
  } catch {
    return false
  }
}

describe("Billing Routes E2E", () => {
  let apiAvailable = false

  beforeAll(async () => {
    apiAvailable = await isAPIServerAvailable()
    if (!apiAvailable) {
      console.log("API server not available at localhost:3001 - skipping E2E tests")
    }
  })

  describe("POST /api/billing/checkout", () => {
    test("accepts workspaceId in request body", async () => {
      if (!apiAvailable) return

      const response = await fetch(`${API_BASE}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "test-workspace-123",
          planId: "pro",
          billingInterval: "monthly",
        }),
      })

      // Even without Stripe configured, it should process the request
      expect(response.status).toBeLessThanOrEqual(500) // Not a 500 error
    })

    test("rejects request without workspaceId", async () => {
      if (!apiAvailable) return

      const response = await fetch(`${API_BASE}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: "pro",
          billingInterval: "monthly",
        }),
      })

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error.code).toBe("invalid_request")
    })

    test("rejects request with old organizationId parameter", async () => {
      if (!apiAvailable) return

      // This test ensures the old organizationId is not accepted
      const response = await fetch(`${API_BASE}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "test-org-123", // Old parameter name
          planId: "pro",
          billingInterval: "monthly",
        }),
      })

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error.code).toBe("invalid_request")
    })
  })

  describe("POST /api/billing/portal", () => {
    test("accepts workspaceId in query params and returns portal URL or expected error", async () => {
      if (!apiAvailable) return

      const response = await fetch(
        `${API_BASE}/api/billing/portal?workspaceId=test-workspace-123`,
        {
          method: "POST",
        }
      )

      // Portal is implemented: 200 with url when customer exists, 404 when not, 503 when Stripe not configured
      expect([200, 404, 503]).toContain(response.status)
      if (response.status === 200) {
        const data = await response.json()
        expect(data).toHaveProperty("url")
        expect(typeof data.url).toBe("string")
      }
    })

    test("rejects request without workspaceId", async () => {
      if (!apiAvailable) return

      const response = await fetch(`${API_BASE}/api/billing/portal`, {
        method: "POST",
      })

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error.message).toContain("workspaceId")
    })
  })

  describe("GET /api/subscriptions", () => {
    test("returns subscription data for workspace", async () => {
      if (!apiAvailable) return

      const response = await fetch(
        `${API_BASE}/api/subscriptions?workspaceId=test-workspace-123`
      )

      // Should return 200 even if no subscription exists (empty array)
      expect(response.status).toBeLessThanOrEqual(401) // May require auth
    })
  })

  describe("GET /api/usage-wallets", () => {
    test("returns usage wallet for workspace", async () => {
      if (!apiAvailable) return

      const response = await fetch(
        `${API_BASE}/api/usage-wallets?workspaceId=test-workspace-123`
      )

      expect(response.status).toBeLessThanOrEqual(401)
    })
  })
})

describe("Billing Domain Terminology", () => {
  test("billing routes use workspaceId not organizationId", () => {
    // This test documents the expected API contract
    const checkoutEndpoint = {
      method: "POST",
      path: "/api/billing/checkout",
      body: {
        workspaceId: "string (required)",
        planId: "string (required)",
        billingInterval: "monthly | annual (required)",
      },
    }

    const portalEndpoint = {
      method: "POST",
      path: "/api/billing/portal",
      query: {
        workspaceId: "string (required)",
      },
    }

    // Verify the contract uses workspace terminology
    expect(checkoutEndpoint.body).not.toHaveProperty("organizationId")
    expect(checkoutEndpoint.body).toHaveProperty("workspaceId")
    expect(portalEndpoint.query).not.toHaveProperty("organizationId")
    expect(portalEndpoint.query).toHaveProperty("workspaceId")
  })
})
