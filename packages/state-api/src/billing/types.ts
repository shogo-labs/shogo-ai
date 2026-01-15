/**
 * Billing Service Types
 *
 * Pure type definitions for the billing layer.
 * NO runtime imports - interface contract only.
 */

// ============================================================
// PLAN & SUBSCRIPTION TYPES
// ============================================================

/**
 * Available plan IDs
 */
export type PlanId = "pro" | "business" | "enterprise"

/**
 * Billing interval options
 */
export type BillingInterval = "monthly" | "annual"

/**
 * Subscription status values
 */
export type SubscriptionStatus = "active" | "canceled" | "past_due" | "unpaid"

/**
 * Subscription entity (domain type, not Stripe SDK type)
 */
export interface Subscription {
  id: string
  organizationId: string
  stripeSubscriptionId: string
  stripeCustomerId: string
  planId: PlanId
  status: SubscriptionStatus
  billingInterval: BillingInterval
  currentPeriodStart: number
  currentPeriodEnd: number
  cancelAtPeriodEnd?: boolean
  createdAt: number
  updatedAt?: number
}

// ============================================================
// CREDIT TYPES
// ============================================================

/**
 * Credit allocation parameters for new subscriptions or resets
 */
export interface CreditAllocation {
  monthlyCredits: number
  dailyCredits: number
}

// ============================================================
// CHECKOUT & PORTAL TYPES
// ============================================================

/**
 * Result from creating a checkout session
 */
export interface CheckoutSessionResult {
  sessionId: string
  url: string
}

/**
 * Result from creating a portal session
 */
export interface PortalSessionResult {
  url: string
}

// ============================================================
// WEBHOOK TYPES
// ============================================================

/**
 * Webhook event types we handle
 */
export type WebhookEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.deleted"
  | "invoice.payment_failed"

/**
 * Webhook event payload (domain type)
 */
export interface WebhookEvent {
  type: WebhookEventType
  data: {
    subscriptionId?: string
    organizationId?: string
    planId?: PlanId
    status?: SubscriptionStatus
    currentPeriodStart?: number
    currentPeriodEnd?: number
    invoiceId?: string
    failureMessage?: string
  }
}

// ============================================================
// ERROR TYPES
// ============================================================

/**
 * Billing error codes
 */
export type BillingErrorCode =
  | "subscription_not_found"
  | "payment_failed"
  | "invalid_plan"
  | "webhook_verification_failed"
  | "customer_not_found"
  | "portal_creation_failed"

/**
 * Billing error structure
 */
export interface BillingError {
  code: BillingErrorCode
  message: string
  originalError?: unknown
}

/**
 * Type guard to check if error is a BillingError
 */
export function isBillingError(error: unknown): error is BillingError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as BillingError).code === "string" &&
    typeof (error as BillingError).message === "string"
  )
}

/**
 * Helper to create a BillingError
 */
export function createBillingError(
  code: BillingErrorCode,
  message: string,
  originalError?: unknown
): BillingError {
  return { code, message, originalError }
}

// ============================================================
// SERVICE INTERFACE
// ============================================================

/**
 * Billing service interface - contract for billing providers
 *
 * Implementations:
 * - StripeBillingService: Real Stripe integration
 * - MockBillingService: In-memory mock for testing
 */
export interface IBillingService {
  /**
   * Create a Stripe checkout session for subscribing to a plan
   *
   * @param organizationId - The organization subscribing
   * @param planId - The plan to subscribe to
   * @param billingInterval - Monthly or annual billing
   * @returns Checkout session with redirect URL
   */
  createCheckoutSession(
    organizationId: string,
    planId: PlanId,
    billingInterval: BillingInterval
  ): Promise<CheckoutSessionResult>

  /**
   * Get subscription details
   *
   * @param subscriptionId - The Stripe subscription ID
   * @returns Subscription or null if not found
   */
  getSubscription(subscriptionId: string): Promise<Subscription | null>

  /**
   * Update subscription (plan change, interval change)
   *
   * @param subscriptionId - The Stripe subscription ID
   * @param updates - Fields to update
   * @returns Updated subscription
   */
  updateSubscription(
    subscriptionId: string,
    updates: { planId?: PlanId; billingInterval?: BillingInterval }
  ): Promise<Subscription>

  /**
   * Cancel subscription at period end
   *
   * @param subscriptionId - The Stripe subscription ID
   * @returns Updated subscription with cancellation scheduled
   */
  cancelSubscription(subscriptionId: string): Promise<Subscription>

  /**
   * Get URL for Stripe Customer Portal
   *
   * @param organizationId - The organization (maps to Stripe customer)
   * @returns Portal session with redirect URL
   */
  getPortalUrl(organizationId: string): Promise<PortalSessionResult>

  /**
   * Process incoming webhook event from Stripe
   *
   * @param payload - Raw webhook payload
   * @param signature - Stripe signature header
   * @returns Parsed webhook event
   * @throws BillingError with code 'webhook_verification_failed' if signature invalid
   */
  processWebhookEvent(payload: string, signature: string): Promise<WebhookEvent>
}
