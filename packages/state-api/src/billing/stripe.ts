/**
 * Stripe Billing Service
 *
 * Real implementation of IBillingService using Stripe SDK.
 */

import type Stripe from "stripe"
import type {
  IBillingService,
  PlanId,
  BillingInterval,
  Subscription,
  CheckoutSessionResult,
  PortalSessionResult,
  WebhookEvent,
  WebhookEventType,
  BillingError,
} from "./types"
import { createBillingError } from "./types"

/**
 * Price ID configuration for each plan/interval combination
 */
export interface StripePriceConfig {
  pro: { monthly: string; annual: string }
  business: { monthly: string; annual: string }
  enterprise: { monthly: string; annual: string }
}

/**
 * Mapping from Stripe price IDs to plan IDs
 */
export type PriceIdToPlanMap = Record<string, PlanId>

/**
 * StripeBillingService implements IBillingService with real Stripe SDK integration.
 *
 * Usage:
 * ```typescript
 * import Stripe from 'stripe'
 *
 * const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
 * const service = new StripeBillingService(stripe, process.env.STRIPE_WEBHOOK_SECRET!, priceConfig, priceMap)
 * ```
 */
export class StripeBillingService implements IBillingService {
  constructor(
    private stripe: Stripe,
    private webhookSecret: string,
    private priceConfig: StripePriceConfig,
    private priceIdToPlan: PriceIdToPlanMap
  ) {}

  /**
   * Create a Stripe checkout session for subscribing to a plan
   */
  async createCheckoutSession(
    workspaceId: string,
    planId: PlanId,
    billingInterval: BillingInterval
  ): Promise<CheckoutSessionResult> {
    const priceId = this.getPriceId(planId, billingInterval)

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        workspaceId,
      },
      subscription_data: {
        metadata: {
          workspaceId,
        },
      },
      success_url: `${process.env.APP_URL || "http://localhost:3000"}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || "http://localhost:3000"}/billing/cancel`,
    })

    return {
      sessionId: session.id,
      url: session.url!,
    }
  }

  /**
   * Get subscription details
   */
  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId)
      return this.mapStripeSubscription(sub)
    } catch (error: any) {
      // Return null for not found errors
      if (error.code === "resource_missing" || error.type === "StripeInvalidRequestError") {
        return null
      }
      throw error
    }
  }

  /**
   * Update subscription (plan change, interval change)
   */
  async updateSubscription(
    subscriptionId: string,
    updates: { planId?: PlanId; billingInterval?: BillingInterval }
  ): Promise<Subscription> {
    // First get the current subscription to know current settings
    const current = await this.stripe.subscriptions.retrieve(subscriptionId)

    // Determine what price to set
    let priceId: string | undefined
    if (updates.planId || updates.billingInterval) {
      const currentPriceId = current.items.data[0]?.price?.id
      const currentPlan = currentPriceId ? this.priceIdToPlan[currentPriceId] : "pro"
      const currentInterval = this.inferInterval(currentPriceId || "") || "monthly"

      priceId = this.getPriceId(
        updates.planId || currentPlan,
        updates.billingInterval || currentInterval
      )
    }

    const updateParams: Stripe.SubscriptionUpdateParams = {
      proration_behavior: "create_prorations",
    }

    if (priceId) {
      updateParams.items = [
        {
          id: current.items.data[0].id,
          price: priceId,
        },
      ]
    }

    const updated = await this.stripe.subscriptions.update(subscriptionId, updateParams)
    return this.mapStripeSubscription(updated)
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription(subscriptionId: string): Promise<Subscription> {
    const updated = await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    })
    return this.mapStripeSubscription(updated)
  }

  /**
   * Get URL for Stripe Customer Portal
   */
  async getPortalUrl(workspaceId: string): Promise<PortalSessionResult> {
    // Look up customer ID from workspace
    // In real implementation, this would query your database
    // For now, we assume workspaceId is passed as customer metadata
    const customers = await this.stripe.customers.search({
      query: `metadata['workspaceId']:'${workspaceId}'`,
    })

    if (customers.data.length === 0) {
      throw createBillingError(
        "customer_not_found",
        `No Stripe customer found for workspace ${workspaceId}`
      )
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${process.env.APP_URL || "http://localhost:3000"}/billing`,
    })

    return { url: session.url }
  }

  /**
   * Process incoming webhook event from Stripe
   * Uses constructEventAsync for Bun compatibility (SubtleCrypto requires async)
   */
  async processWebhookEvent(payload: string, signature: string): Promise<WebhookEvent> {
    let event: Stripe.Event

    try {
      // Use async version for Bun/SubtleCrypto compatibility
      event = await this.stripe.webhooks.constructEventAsync(
        payload,
        signature,
        this.webhookSecret
      )
    } catch (error: any) {
      throw createBillingError(
        "webhook_verification_failed",
        "Webhook signature verification failed",
        error
      )
    }

    return this.mapStripeEvent(event)
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Get price ID for plan and interval combination
   */
  private getPriceId(planId: PlanId, interval: BillingInterval): string {
    const planConfig = this.priceConfig[planId]
    if (!planConfig) {
      throw createBillingError("invalid_plan", `Unknown plan: ${planId}`)
    }
    return planConfig[interval]
  }

  /**
   * Infer billing interval from price ID
   */
  private inferInterval(priceId: string): BillingInterval | null {
    if (priceId.includes("annual")) return "annual"
    if (priceId.includes("monthly")) return "monthly"
    return null
  }

  /**
   * Map Stripe subscription to domain type
   */
  private mapStripeSubscription(sub: Stripe.Subscription): Subscription {
    const priceId = sub.items.data[0]?.price?.id
    const planId = priceId ? this.priceIdToPlan[priceId] || "pro" : "pro"

    // Get current period from the first subscription item
    const firstItem = sub.items.data[0]
    const currentPeriodStart = firstItem?.current_period_start ?? sub.start_date
    const currentPeriodEnd = firstItem?.current_period_end ?? (sub.cancel_at ?? Date.now() / 1000)

    return {
      id: sub.id,
      workspaceId: (sub.metadata?.workspaceId as string) || "",
      stripeSubscriptionId: sub.id,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      planId,
      status: sub.status as Subscription["status"],
      billingInterval: this.inferInterval(priceId || "") || "monthly",
      currentPeriodStart: currentPeriodStart * 1000, // Convert to ms
      currentPeriodEnd: currentPeriodEnd * 1000,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      createdAt: sub.created * 1000,
      updatedAt: Date.now(),
    }
  }

  /**
   * Map Stripe event to domain webhook event
   */
  private mapStripeEvent(event: Stripe.Event): WebhookEvent {
    const eventTypeMap: Record<string, WebhookEventType> = {
      "customer.subscription.created": "subscription.created",
      "customer.subscription.updated": "subscription.updated",
      "customer.subscription.deleted": "subscription.deleted",
      "invoice.payment_failed": "invoice.payment_failed",
    }

    const webhookType = eventTypeMap[event.type] || "subscription.updated"
    const data: WebhookEvent["data"] = {}

    if (event.type.startsWith("customer.subscription")) {
      const sub = event.data.object as Stripe.Subscription
      const priceId = sub.items?.data[0]?.price?.id
      const firstItem = sub.items?.data[0]

      data.subscriptionId = sub.id
      data.workspaceId = sub.metadata?.workspaceId
      data.status = sub.status as Subscription["status"]
      // Get current period from subscription item
      data.currentPeriodStart = (firstItem?.current_period_start ?? sub.start_date) * 1000
      data.currentPeriodEnd = (firstItem?.current_period_end ?? (sub.cancel_at ?? Date.now() / 1000)) * 1000

      if (priceId) {
        data.planId = this.priceIdToPlan[priceId]
      }
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice
      data.invoiceId = invoice.id || undefined
      // Get customer info - workspace lookup will need to happen via customer ID
      const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id
      data.workspaceId = customerId // Caller will need to resolve customer -> org
      data.failureMessage = invoice.last_finalization_error?.message
    }

    return { type: webhookType, data }
  }
}
