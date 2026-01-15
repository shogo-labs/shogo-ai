/**
 * Stripe Webhook Handler
 *
 * Processes Stripe webhook events for subscription lifecycle management.
 * Events: subscription.created, subscription.updated, subscription.deleted, invoice.payment_failed
 */

import type { Context } from "hono"
import type { IBillingService, WebhookEvent } from "@shogo/state-api"
import { isBillingError } from "@shogo/state-api"

/**
 * Configuration for the webhook handler
 */
export interface StripeWebhookConfig {
  /** Billing service for signature verification and event parsing */
  billingService: IBillingService
  /** Billing domain store for updating local state */
  billingStore: {
    syncFromStripe: (data: {
      subscriptionId: string
      organizationId: string
      customerId?: string
      planId?: string
      status?: string
      billingInterval?: string
      currentPeriodStart?: number
      currentPeriodEnd?: number
      cancelAtPeriodEnd?: boolean
      isNew?: boolean
    }) => Promise<void>
    allocateMonthlyCredits?: (orgId: string) => Promise<void>
  }
}

/**
 * Create a Stripe webhook handler for Hono
 *
 * @param config - Handler configuration
 * @returns Hono handler function
 */
export function stripeWebhookHandler(config: StripeWebhookConfig) {
  const { billingService, billingStore } = config

  return async (c: Context) => {
    try {
      // Get raw body and Stripe signature
      const payload = await c.req.text()
      const signature = c.req.header("stripe-signature") || ""

      // Verify signature and parse event via billing service
      let event: WebhookEvent
      try {
        event = await billingService.processWebhookEvent(payload, signature)
      } catch (error) {
        // Signature verification failed
        if (isBillingError(error) && error.code === "webhook_verification_failed") {
          console.error("[Webhook] Signature verification failed:", error.message)
          return c.json({ error: "Invalid signature" }, 400)
        }
        throw error
      }

      console.log("[Webhook] Processing event:", event.type, event.data)

      // Process event based on type
      try {
        switch (event.type) {
          case "subscription.created":
            await handleSubscriptionCreated(event, billingStore)
            break

          case "subscription.updated":
            await handleSubscriptionUpdated(event, billingStore)
            break

          case "subscription.deleted":
            await handleSubscriptionDeleted(event, billingStore)
            break

          case "invoice.payment_failed":
            await handlePaymentFailed(event, billingStore)
            break

          default:
            console.log("[Webhook] Unhandled event type:", event.type)
        }
      } catch (businessError) {
        // Log business logic errors but return 200 to prevent Stripe retries
        console.error("[Webhook] Business logic error:", businessError)
        // Still return 200 - we don't want Stripe to retry for business logic issues
      }

      // Always return 200 for valid signatures
      return c.json({ received: true }, 200)
    } catch (error) {
      console.error("[Webhook] Unexpected error:", error)
      // Return 500 for truly unexpected errors
      return c.json({ error: "Internal error" }, 500)
    }
  }
}

/**
 * Handle subscription.created event
 * Creates subscription and allocates initial credits
 */
async function handleSubscriptionCreated(
  event: WebhookEvent,
  billingStore: StripeWebhookConfig["billingStore"]
) {
  const { subscriptionId, organizationId, planId, status, currentPeriodStart, currentPeriodEnd } =
    event.data

  if (!subscriptionId || !organizationId) {
    console.error("[Webhook] Missing required data for subscription.created")
    return
  }

  await billingStore.syncFromStripe({
    subscriptionId,
    organizationId,
    planId: planId || "pro",
    status: status || "active",
    currentPeriodStart: currentPeriodStart || Date.now(),
    currentPeriodEnd: currentPeriodEnd || Date.now() + 30 * 24 * 60 * 60 * 1000,
    isNew: true,
  })

  console.log("[Webhook] Subscription created for org:", organizationId)
}

/**
 * Handle subscription.updated event
 * Updates local subscription state (plan changes, status changes)
 */
async function handleSubscriptionUpdated(
  event: WebhookEvent,
  billingStore: StripeWebhookConfig["billingStore"]
) {
  const { subscriptionId, organizationId, planId, status, currentPeriodStart, currentPeriodEnd } =
    event.data

  if (!subscriptionId) {
    console.error("[Webhook] Missing subscriptionId for subscription.updated")
    return
  }

  await billingStore.syncFromStripe({
    subscriptionId,
    organizationId: organizationId || "",
    planId,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    isNew: false,
  })

  console.log("[Webhook] Subscription updated:", subscriptionId)
}

/**
 * Handle subscription.deleted event
 * Marks subscription as canceled
 */
async function handleSubscriptionDeleted(
  event: WebhookEvent,
  billingStore: StripeWebhookConfig["billingStore"]
) {
  const { subscriptionId, organizationId } = event.data

  if (!subscriptionId) {
    console.error("[Webhook] Missing subscriptionId for subscription.deleted")
    return
  }

  await billingStore.syncFromStripe({
    subscriptionId,
    organizationId: organizationId || "",
    status: "canceled",
    isNew: false,
  })

  console.log("[Webhook] Subscription canceled:", subscriptionId)
}

/**
 * Handle invoice.payment_failed event
 * Could update subscription status to past_due or unpaid
 */
async function handlePaymentFailed(
  event: WebhookEvent,
  _billingStore: StripeWebhookConfig["billingStore"]
) {
  const { invoiceId, failureMessage, organizationId } = event.data

  // Log the failure - in production, would also notify org admins
  console.warn("[Webhook] Payment failed:", {
    invoiceId,
    failureMessage,
    organizationId,
  })

  // Note: subscription status will be updated via subscription.updated event
  // when Stripe transitions it to past_due or unpaid
}

/**
 * Export for direct use in server.ts
 */
export default stripeWebhookHandler
