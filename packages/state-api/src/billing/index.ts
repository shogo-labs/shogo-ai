/**
 * Billing Module Exports
 *
 * Re-exports all billing-related types, services, and domain store.
 */

// Types (interface contract)
export type {
  IBillingService,
  PlanId,
  BillingInterval,
  SubscriptionStatus,
  Subscription,
  CreditAllocation,
  CheckoutSessionResult,
  PortalSessionResult,
  WebhookEvent,
  WebhookEventType,
  BillingError,
  BillingErrorCode,
} from "./types"

// Type utilities (runtime)
export { isBillingError, createBillingError } from "./types"

// Services
export { StripeBillingService } from "./stripe"
export type { StripePriceConfig, PriceIdToPlanMap } from "./stripe"

// Domain store
export { BillingDomain, billingDomain } from "./domain"
