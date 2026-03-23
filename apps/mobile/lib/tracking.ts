// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { PRO_TIERS, BUSINESS_TIERS, type PriceTier } from './billing-config'

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

export function trackSignUp(method: 'email' | 'google') {
  const eventId = generateEventId('signup')

  fbq('track', 'CompleteRegistration', {
    content_name: method,
    status: true,
  }, { eventID: eventId })

  gtag('event', 'sign_up', { method })
}

export function trackLogin(method: 'email' | 'google') {
  fbq('track', 'Lead', {
    content_name: method,
  })

  gtag('event', 'login', { method })
}

export function lookupPlanValue(planId: string, billingInterval: string): number | undefined {
  const isAnnual = billingInterval === 'annual'
  const match = planId.match(/^(pro|business)(?:_(\d+))?$/)
  if (!match) return undefined

  const planType = match[1] as 'pro' | 'business'
  const credits = match[2] ? parseInt(match[2], 10) : 100
  const tiers: PriceTier[] = planType === 'pro' ? PRO_TIERS : BUSINESS_TIERS
  const tier = tiers.find((t) => t.credits === credits)
  if (!tier) return undefined

  return isAnnual ? tier.annual : tier.monthly
}

export function trackInitiateCheckout(params: {
  planId: string
  billingInterval: string
  value?: number
  workspaceId?: string
}) {
  const value = params.value ?? lookupPlanValue(params.planId, params.billingInterval)
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
  value?: number
  workspaceId?: string
  sessionId?: string
}) {
  const value = params.value ??
    (params.planId && params.billingInterval
      ? lookupPlanValue(params.planId, params.billingInterval)
      : undefined)
  const eventId = params.sessionId ?? generateEventId('purchase')

  // Primary conversion event for ad optimization
  fbq('track', 'Purchase', {
    content_ids: params.planId ? [params.planId] : undefined,
    content_name: params.planId,
    content_category: 'subscription',
    content_type: 'product',
    currency: 'USD',
    value,
    num_items: 1,
  }, { eventID: eventId })

  // Subscription-specific event for Meta reporting
  fbq('track', 'Subscribe', {
    content_name: params.planId,
    currency: 'USD',
    value,
    predicted_ltv: value != null ? value * 12 : undefined,
  }, { eventID: `${eventId}_sub` })

  gtag('event', 'purchase', {
    currency: 'USD',
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
