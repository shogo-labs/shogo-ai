/**
 * Billing API Routes
 *
 * Authenticated endpoints for billing operations.
 * Uses Prisma-based billing service.
 */

import { Hono } from "hono"
import * as billingService from "../services/billing.service"

/**
 * Auth context expected from authentication middleware
 */
interface AuthContext {
  workspaceId: string
  userId?: string
  isBillingAdmin?: boolean
}

/**
 * Create billing routes
 */
export function billingRoutes() {
  const router = new Hono()

  /**
   * GET /subscription - Get current subscription and credit balance
   *
   * Response:
   * - subscription: Subscription | null
   * - credits: { monthlyCredits, dailyCredits, rolloverCredits, total }
   */
  router.get("/subscription", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.workspaceId) {
        return c.json({ error: { code: "unauthorized", message: "Missing workspace context" } }, 401)
      }

      // Get subscription from Prisma
      const subscription = await billingService.getSubscription(auth.workspaceId)

      // Get credit balance from Prisma
      const ledger = await billingService.getCreditLedger(auth.workspaceId)
      const credits = ledger
        ? {
            dailyCredits: ledger.dailyCredits,
            monthlyCredits: ledger.monthlyCredits,
            rolloverCredits: ledger.rolloverCredits,
            total: ledger.dailyCredits + ledger.monthlyCredits + ledger.rolloverCredits,
          }
        : { dailyCredits: 0, monthlyCredits: 0, rolloverCredits: 0, total: 0 }

      return c.json({ subscription, credits }, 200)
    } catch (error) {
      console.error("[Billing API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * GET /usage - Get usage events for the workspace
   *
   * Query params:
   * - projectId: string (optional)
   * - limit: number (optional, default 100)
   * - offset: number (optional, default 0)
   */
  router.get("/usage", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.workspaceId) {
        return c.json({ error: { code: "unauthorized", message: "Missing workspace context" } }, 401)
      }

      const projectId = c.req.query("projectId")
      const limit = parseInt(c.req.query("limit") || "100", 10)
      const offset = parseInt(c.req.query("offset") || "0", 10)

      const events = await billingService.getUsageEvents(auth.workspaceId, {
        projectId: projectId || undefined,
        limit,
        offset,
      })

      return c.json({ events }, 200)
    } catch (error) {
      console.error("[Billing API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * POST /allocate-credits - Allocate free credits for a workspace (admin only)
   */
  router.post("/allocate-credits", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.workspaceId) {
        return c.json({ error: { code: "unauthorized", message: "Missing workspace context" } }, 401)
      }

      const ledger = await billingService.allocateFreeCredits(auth.workspaceId)

      return c.json({ ledger }, 200)
    } catch (error) {
      console.error("[Billing API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  return router
}

export default billingRoutes
