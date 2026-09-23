// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing seam shared by chat routes.
 *
 * Local/desktop mode has no Stripe subscription or cloud wallet. Keeping the
 * cloud implementation behind this seam prevents the local route graph from
 * importing the Stripe-heavy billing service while preserving the same route
 * code and authorization behavior in cloud mode.
 */
let cloudBilling: any = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  cloudBilling = await import(new URL('./billing.service.ts', import.meta.url).href)
}

export const SYSTEM_WORKSPACE_ID = cloudBilling?.SYSTEM_WORKSPACE_ID ?? 'local-system'
export const checkUsageBalance = (...args: any[]) =>
  cloudBilling?.checkUsageBalance?.(...args) ?? Promise.resolve({ allowed: true })
export const usageLimitErrorPayload = (...args: any[]) =>
  cloudBilling?.usageLimitErrorPayload?.(...args) ?? { error: 'usage_limit' }
export const hasAdvancedModelAccess = (...args: any[]) =>
  cloudBilling?.hasAdvancedModelAccess?.(...args) ?? Promise.resolve(true)
export const allocateMonthlyIncluded = (...args: any[]) =>
  cloudBilling?.allocateMonthlyIncluded?.(...args) ?? Promise.resolve(null)
export const consumeUsage = (...args: any[]) =>
  cloudBilling?.consumeUsage?.(...args) ?? Promise.resolve(null)
export const ensureSystemWorkspace = (...args: any[]) =>
  cloudBilling?.ensureSystemWorkspace?.(...args) ?? Promise.resolve(null)
export const getSubscription = (...args: any[]) =>
  cloudBilling?.getSubscription?.(...args) ?? Promise.resolve(null)
export const getUsageWallet = (...args: any[]) =>
  cloudBilling?.getUsageWallet?.(...args) ?? Promise.resolve(null)
export const getUsageWindows = (...args: any[]) =>
  cloudBilling?.getUsageWindows?.(...args) ?? Promise.resolve(null)
export const syncFromStripe = (...args: any[]) =>
  cloudBilling?.syncFromStripe?.(...args) ?? Promise.resolve(null)
export const hasBalance = (...args: any[]) =>
  cloudBilling?.hasBalance?.(...args) ?? Promise.resolve(true)
