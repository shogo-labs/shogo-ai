// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { PLAN_PRICING } from './billing-config'

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
    gtag?: (...args: unknown[]) => void
  }
}

let eventCounter = 0
function generateEventId(prefix: string) {
  return `${prefix}_${Date.now()}_${++eventCounter}`
}

function isWeb() {
  return Platform.OS === 'web' && typeof window !== 'undefined'
}

function fbq(...args: unknown[]) {
  if (!isWeb()) return
  window.fbq?.(...args)
}

function gtag(...args: unknown[]) {
  if (!isWeb()) return
  window.gtag?.(...args)
}

export function trackSignUp(method: 'email' | 'google' | 'apple') {
  const eventId = generateEventId('signup')

  fbq('track', 'CompleteRegistration', {
    content_name: method,
    status: true,
  }, { eventID: eventId })

  gtag('event', 'sign_up', { method })
}

export function trackLogin(method: 'email' | 'google' | 'apple') {
  fbq('track', 'Lead', {
    content_name: method,
  })

  gtag('event', 'login', { method })
}

/**
 * Look up the per-subscription dollar value for analytics.
 * For per-seat plans (Pro/Business), pass `seats` to get the total cost.
 */
export function lookupPlanValue(
  planId: string,
  billingInterval: string,
  seats: number = 1,
): number | undefined {
  const isAnnual = billingInterval === 'annual'
  const base = planId.split('_')[0]
  if (base !== 'basic' && base !== 'pro' && base !== 'business') return undefined
  const pricing = PLAN_PRICING[base as 'basic' | 'pro' | 'business']
  const safeSeats = pricing.perSeat ? Math.max(1, Math.floor(seats || 1)) : 1
  const unit = isAnnual ? pricing.annual : pricing.monthly
  return unit * safeSeats
}

export function trackInitiateCheckout(params: {
  planId: string
  billingInterval: string
  seats?: number
  value?: number
  workspaceId?: string
}) {
  const value = params.value ?? lookupPlanValue(params.planId, params.billingInterval, params.seats)
  const eventId = generateEventId('checkout')

  fbq('track', 'InitiateCheckout', {
    content_ids: [params.planId],
    content_name: params.planId,
    content_category: 'subscription',
    currency: 'USD',
    value,
    num_items: 1,
  }, { eventID: eventId })

  gtag('event', 'begin_checkout', {
    currency: 'USD',
    value,
    items: [{
      item_id: params.planId,
      item_name: params.planId,
      item_category: 'subscription',
      item_variant: params.billingInterval,
      price: value,
      quantity: 1,
    }],
  })
}

export function trackPurchase(params: {
  planId?: string
  billingInterval?: string
  seats?: number
  value?: number
  currency?: string
  workspaceId?: string
  sessionId?: string
}) {
  const hasChargedValue = params.value != null
  const value = params.value ??
    (params.planId && params.billingInterval
      ? lookupPlanValue(params.planId, params.billingInterval, params.seats)
      : undefined)
  const currency = hasChargedValue && params.currency ? params.currency.toUpperCase() : 'USD'
  const eventId = params.sessionId ?? generateEventId('purchase')

  // Primary conversion event for ad optimization
  fbq('track', 'Purchase', {
    content_ids: params.planId ? [params.planId] : undefined,
    content_name: params.planId,
    content_category: 'subscription',
    content_type: 'product',
    currency,
    value,
    num_items: 1,
  }, { eventID: eventId })

  // Subscription-specific event for Meta reporting
  fbq('track', 'Subscribe', {
    content_name: params.planId,
    currency,
    value,
    predicted_ltv: value != null ? value * 12 : undefined,
  }, { eventID: `${eventId}_sub` })

  gtag('event', 'purchase', {
    currency,
    value,
    transaction_id: params.sessionId ?? params.workspaceId,
    items: [{
      item_id: params.planId,
      item_name: params.planId,
      item_category: 'subscription',
      price: value,
      quantity: 1,
    }],
  })
}

/**
 * The billing page was opened (SHO-451). Fires once per mount so we can see
 * how often people land on billing and what plan they land on.
 */
export function trackBillingView(params: {
  workspaceId?: string
  planId?: string
  hasSubscription: boolean
}) {
  fbq('trackCustom', 'BillingView', {
    content_name: params.planId,
    content_category: 'billing',
    has_subscription: params.hasSubscription,
  })

  gtag('event', 'view_billing', {
    plan_id: params.planId,
    has_subscription: params.hasSubscription,
    workspace_id: params.workspaceId,
  })
}

/**
 * A plan button was pressed. `action` says which path it took, so a click that
 * opens Checkout is never confused with one that changes the existing
 * subscription in place.
 */
export function trackPlanClick(params: {
  planId: string
  action: 'checkout' | 'trial' | 'change' | 'contact'
  billingInterval?: string
  seats?: number
  workspaceId?: string
}) {
  const value = params.billingInterval
    ? lookupPlanValue(params.planId, params.billingInterval, params.seats)
    : undefined

  fbq('trackCustom', 'PlanClick', {
    content_ids: [params.planId],
    content_name: params.planId,
    content_category: 'subscription',
    action: params.action,
    currency: 'USD',
    value,
  })

  gtag('event', 'select_plan', {
    plan_id: params.planId,
    action: params.action,
    billing_interval: params.billingInterval,
    seats: params.seats,
    currency: 'USD',
    value,
    workspace_id: params.workspaceId,
  })
}

/** A plan change was applied to the existing subscription. */
export function trackPlanChange(params: {
  fromPlanId?: string
  planId: string
  billingInterval?: string
  seats?: number
  workspaceId?: string
}) {
  const value = params.billingInterval
    ? lookupPlanValue(params.planId, params.billingInterval, params.seats)
    : undefined

  fbq('trackCustom', 'PlanChange', {
    content_name: params.planId,
    content_category: 'subscription',
    previous_plan: params.fromPlanId,
    currency: 'USD',
    value,
  })

  gtag('event', 'change_plan', {
    plan_id: params.planId,
    previous_plan_id: params.fromPlanId,
    billing_interval: params.billingInterval,
    seats: params.seats,
    currency: 'USD',
    value,
    workspace_id: params.workspaceId,
  })
}

/** A subscription was cancelled at period end, or a cancellation was undone. */
export function trackCancel(params: {
  planId?: string
  action: 'cancel' | 'resume'
  workspaceId?: string
}) {
  fbq('trackCustom', params.action === 'cancel' ? 'CancelSubscription' : 'ResumeSubscription', {
    content_name: params.planId,
    content_category: 'subscription',
  })

  gtag('event', params.action === 'cancel' ? 'cancel_subscription' : 'resume_subscription', {
    plan_id: params.planId,
    workspace_id: params.workspaceId,
  })
}
