// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
    dataLayer?: Record<string, unknown>[]
  }
}

function isWeb() {
  return Platform.OS === 'web' && typeof window !== 'undefined'
}

function fbq(...args: unknown[]) {
  if (!isWeb()) return
  window.fbq?.(...args)
}

function pushToDataLayer(event: string, ecommerce: Record<string, unknown>) {
  if (!isWeb()) return
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({ ecommerce: null })
  window.dataLayer.push({ event, ecommerce })
}

export function trackInitiateCheckout(params: {
  planId: string
  billingInterval: string
  workspaceId?: string
}) {
  fbq('track', 'InitiateCheckout', {
    content_name: params.planId,
    content_category: 'subscription',
    billing_interval: params.billingInterval,
    workspace_id: params.workspaceId,
  })

  pushToDataLayer('begin_checkout', {
    items: [{
      item_name: params.planId,
      item_category: 'subscription',
      item_variant: params.billingInterval,
    }],
  })
}

export function trackPurchase(params: {
  planId?: string
  workspaceId?: string
}) {
  fbq('track', 'Purchase', {
    content_name: params.planId,
    content_category: 'subscription',
    workspace_id: params.workspaceId,
  })

  pushToDataLayer('purchase', {
    transaction_id: params.workspaceId,
    items: [{
      item_name: params.planId,
      item_category: 'subscription',
    }],
  })
}
