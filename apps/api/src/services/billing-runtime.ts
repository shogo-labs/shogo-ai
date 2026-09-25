// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing seam shared by chat routes.
 *
 * Local/desktop mode has no Stripe subscription or cloud wallet. Keeping the
 * cloud implementation behind this seam prevents the local route graph from
 * importing the Stripe-heavy billing service while preserving the same route
 * code and authorization behavior in cloud mode.
 *
 * The local implementation is typed against the real module (the type-only
 * import is erased at build time) and must reproduce what `billing.service`
 * itself does when `SHOGO_LOCAL_MODE=true`.
 */
import type * as CloudBillingModule from './billing.service'
import type { UsageWindowKind, UsageWindowSnapshot } from './billing.service'
import { getMinimumInstanceSize } from '@shogo/shared-runtime'
import { usageLimitErrorPayload as localUsageLimitErrorPayload } from './usage-limits'
import { recordLocalUsage } from './billing-local'

type CloudBilling = typeof CloudBillingModule
type BillingSeam = Pick<
  CloudBilling,
  | 'SYSTEM_WORKSPACE_ID'
  | 'checkUsageBalance'
  | 'usageLimitErrorPayload'
  | 'hasAdvancedModelAccess'
  | 'allocateMonthlyIncluded'
  | 'consumeUsage'
  | 'ensureSystemWorkspace'
  | 'getSubscription'
  | 'getUsageWallet'
  | 'getUsageWindows'
  | 'syncFromStripe'
  | 'hasBalance'
  | 'hasPaidSubscription'
  | 'canRunTechStackOnInstanceSize'
>

type InstanceSizeName = Awaited<ReturnType<CloudBilling['canRunTechStackOnInstanceSize']>>['currentSize']

let cloudBilling: CloudBilling | null = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  cloudBilling = await import('./billing.service')
}

const uncappedWindow = (kind: UsageWindowKind): UsageWindowSnapshot => ({
  kind,
  usedUsd: 0,
  limitUsd: null,
  utilization: 0,
  resetsAt: null,
})

const unavailableLocally = (operation: string) => async (): Promise<never> => {
  throw new Error(`${operation} is not available in local mode (no Stripe billing on desktop)`)
}

/** Local installs are uncapped and have no subscriptions or wallets. */
export const localBilling: BillingSeam = {
  SYSTEM_WORKSPACE_ID: 'system',
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: localUsageLimitErrorPayload,
  hasAdvancedModelAccess: async () => true,
  hasBalance: async () => true,
  ensureSystemWorkspace: async () => {},
  consumeUsage: recordLocalUsage,
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => ({ fiveHour: uncappedWindow('five_hour'), weekly: uncappedWindow('weekly') }),
  hasPaidSubscription: async () => true,
  // Desktop runs every stack on the host; callers only read `currentSize` to
  // explain a refusal, which never happens here.
  canRunTechStackOnInstanceSize: async (_workspaceId, techStackId) => ({
    allowed: true,
    currentSize: 'micro' as InstanceSizeName,
    requiredSize: getMinimumInstanceSize(techStackId) as InstanceSizeName | null,
  }),
  allocateMonthlyIncluded: unavailableLocally('allocateMonthlyIncluded'),
  syncFromStripe: unavailableLocally('syncFromStripe'),
}

// Looked up per call (not bound at load) so tests that `mock.module()` the
// cloud service after this seam was imported still reach the mock.
const billing = (): BillingSeam => cloudBilling ?? localBilling

export const SYSTEM_WORKSPACE_ID: BillingSeam['SYSTEM_WORKSPACE_ID'] = billing().SYSTEM_WORKSPACE_ID
export const checkUsageBalance: BillingSeam['checkUsageBalance'] = (...args) => billing().checkUsageBalance(...args)
export const usageLimitErrorPayload: BillingSeam['usageLimitErrorPayload'] = (...args) =>
  billing().usageLimitErrorPayload(...args)
export const hasAdvancedModelAccess: BillingSeam['hasAdvancedModelAccess'] = (...args) =>
  billing().hasAdvancedModelAccess(...args)
export const allocateMonthlyIncluded: BillingSeam['allocateMonthlyIncluded'] = (...args) =>
  billing().allocateMonthlyIncluded(...args)
export const consumeUsage: BillingSeam['consumeUsage'] = (...args) => billing().consumeUsage(...args)
export const ensureSystemWorkspace: BillingSeam['ensureSystemWorkspace'] = (...args) =>
  billing().ensureSystemWorkspace(...args)
export const getSubscription: BillingSeam['getSubscription'] = (...args) => billing().getSubscription(...args)
export const getUsageWallet: BillingSeam['getUsageWallet'] = (...args) => billing().getUsageWallet(...args)
export const getUsageWindows: BillingSeam['getUsageWindows'] = (...args) => billing().getUsageWindows(...args)
export const syncFromStripe: BillingSeam['syncFromStripe'] = (...args) => billing().syncFromStripe(...args)
export const hasBalance: BillingSeam['hasBalance'] = (...args) => billing().hasBalance(...args)
export const hasPaidSubscription: BillingSeam['hasPaidSubscription'] = (...args) =>
  billing().hasPaidSubscription(...args)
export const canRunTechStackOnInstanceSize: BillingSeam['canRunTechStackOnInstanceSize'] = (...args) =>
  billing().canRunTechStackOnInstanceSize(...args)
