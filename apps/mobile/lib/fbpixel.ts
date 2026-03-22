// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
  }
}

function fbq(...args: unknown[]) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  window.fbq?.(...args)
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
}
