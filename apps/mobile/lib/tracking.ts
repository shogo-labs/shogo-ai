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

  fbq('track', 'InitiateCheckout', {
    content_name: params.planId,
    content_category: 'subscription',
    currency: 'USD',
    value,
    billing_interval: params.billingInterval,
    workspace_id: params.workspaceId,
  })

  gtag('event', 'begin_checkout', {
    currency: 'USD',
    value,
    items: [{
      item_name: params.planId,
      item_category: 'subscription',
      item_variant: params.billingInterval,
      price: value,
    }],
  })
}

export function trackPurchase(params: {
  planId?: string
  billingInterval?: string
  value?: number
  workspaceId?: string
}) {
  const value = params.value ??
    (params.planId && params.billingInterval
      ? lookupPlanValue(params.planId, params.billingInterval)
      : undefined)

  fbq('track', 'Purchase', {
    content_name: params.planId,
    content_category: 'subscription',
    currency: 'USD',
    value,
    workspace_id: params.workspaceId,
  })

  gtag('event', 'purchase', {
    currency: 'USD',
    value,
    transaction_id: params.workspaceId,
    items: [{
      item_name: params.planId,
      item_category: 'subscription',
      price: value,
    }],
  })
}
