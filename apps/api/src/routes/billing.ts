/**
 * Billing API Routes
 *
 * Authenticated endpoints for billing operations.
 * All routes require authentication and billing admin permission.
 */

import { Hono } from "hono"
import type { IBillingService, BillingError, PlanId, BillingInterval } from "@shogo/state-api"
import { isBillingError } from "@shogo/state-api"

/**
 * Billing route configuration
 */
export interface BillingRoutesConfig {
  /** Billing service for Stripe operations */
  billingService: IBillingService
  /** Billing domain store for local state queries */
  billingStore: {
    subscriptionCollection: {
      findByOrg: (orgId: string) => any[]
    }
    creditLedgerCollection: {
      findByOrg: (orgId: string) => any | null
    }
  }
}

/**
 * Create billing routes
 *
 * @param config - Route configuration
 * @returns Hono router with billing endpoints
 */
export function billingRoutes(config: BillingRoutesConfig) {
  const { billingService, billingStore } = config
  const router = new Hono()

  /**
   * POST /checkout - Create Stripe checkout session
   *
   * Request body:
   * - planId: 'pro' | 'business' | 'enterprise'
   * - billingInterval: 'monthly' | 'annual'
   *
   * Response:
   * - sessionId: string
   * - url: string (redirect URL)
   */
  router.post("/checkout", async (c) => {
    try {
      const auth = c.get("auth") as { organizationId: string } | undefined
      if (!auth?.organizationId) {
        return c.json({ error: { code: "unauthorized", message: "Missing organization context" } }, 401)
      }

      const body = await c.req.json<{ planId: PlanId; billingInterval: BillingInterval }>()
      const { planId, billingInterval } = body

      if (!planId || !billingInterval) {
        return c.json(
          { error: { code: "invalid_request", message: "planId and billingInterval required" } },
          400
        )
      }

      const result = await billingService.createCheckoutSession(
        auth.organizationId,
        planId,
        billingInterval
      )

      return c.json(result, 200)
    } catch (error) {
      return handleBillingError(c, error)
    }
  })

  /**
   * GET /subscription - Get current subscription and credit balance
   *
   * Response:
   * - subscription: Subscription | null
   * - credits: { monthlyCredits, dailyCredits, rolloverCredits, total }
   */
  router.get("/subscription", async (c) => {
    try {
      const auth = c.get("auth") as { organizationId: string } | undefined
      if (!auth?.organizationId) {
        return c.json({ error: { code: "unauthorized", message: "Missing organization context" } }, 401)
      }

      // Get subscription from local store
      const subscriptions = billingStore.subscriptionCollection.findByOrg(auth.organizationId)
      const subscription = subscriptions[0] || null

      // Get credit balance from local store
      const ledger = billingStore.creditLedgerCollection.findByOrg(auth.organizationId)
      const credits = ledger
        ? ledger.effectiveBalance || {
            dailyCredits: ledger.dailyCredits,
            monthlyCredits: ledger.monthlyCredits,
            rolloverCredits: ledger.rolloverCredits,
            total: ledger.dailyCredits + ledger.monthlyCredits + ledger.rolloverCredits,
          }
        : { dailyCredits: 0, monthlyCredits: 0, rolloverCredits: 0, total: 0 }

      return c.json({ subscription, credits }, 200)
    } catch (error) {
      return handleBillingError(c, error)
    }
  })

  /**
   * POST /portal - Get Stripe Customer Portal URL
   *
   * Response:
   * - url: string (redirect URL)
   */
  router.post("/portal", async (c) => {
    try {
      const auth = c.get("auth") as { organizationId: string } | undefined
      if (!auth?.organizationId) {
        return c.json({ error: { code: "unauthorized", message: "Missing organization context" } }, 401)
      }

      const result = await billingService.getPortalUrl(auth.organizationId)
      return c.json(result, 200)
    } catch (error) {
      return handleBillingError(c, error)
    }
  })

  /**
   * POST /cancel - Cancel subscription at period end
   *
   * Response:
   * - subscription: Updated subscription with cancelAtPeriodEnd=true
   */
  router.post("/cancel", async (c) => {
    try {
      const auth = c.get("auth") as { organizationId: string } | undefined
      if (!auth?.organizationId) {
        return c.json({ error: { code: "unauthorized", message: "Missing organization context" } }, 401)
      }

      // Get current subscription
      const subscriptions = billingStore.subscriptionCollection.findByOrg(auth.organizationId)
      const subscription = subscriptions[0]

      if (!subscription) {
        return c.json(
          { error: { code: "subscription_not_found", message: "No active subscription found" } },
          404
        )
      }

      const updatedSubscription = await billingService.cancelSubscription(
        subscription.stripeSubscriptionId
      )

      return c.json({ subscription: updatedSubscription }, 200)
    } catch (error) {
      return handleBillingError(c, error)
    }
  })

  return router
}

/**
 * Handle billing errors and return consistent error response
 */
function handleBillingError(c: any, error: unknown) {
  console.error("[Billing API] Error:", error)

  if (isBillingError(error)) {
    const billingError = error as BillingError
    const status = getStatusForBillingError(billingError.code)
    return c.json({ error: billingError }, status)
  }

  // Generic error
  const message = error instanceof Error ? error.message : "Unknown error"
  return c.json({ error: { code: "internal_error", message } }, 500)
}

/**
 * Map billing error codes to HTTP status codes
 */
function getStatusForBillingError(code: string): number {
  switch (code) {
    case "invalid_plan":
    case "invalid_request":
      return 400
    case "subscription_not_found":
    case "customer_not_found":
      return 404
    case "payment_failed":
      return 402
    case "webhook_verification_failed":
      return 401
    default:
      return 500
  }
}

export default billingRoutes
