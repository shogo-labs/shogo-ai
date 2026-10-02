// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo } from 'react'
import { useBillingData } from '@shogo/shared-app/hooks'
import { usePlatformConfig } from '../lib/platform-config'
import type { UsageOverageContext } from '../lib/billing-config'
import { useCloudBillingSummary } from './useCloudBillingSummary'

// Stable identity so callers can safely list `refreshCloud` in effect deps.
const noopRefresh = async () => null

type BillingData = ReturnType<typeof useBillingData>
type UsageWindows = BillingData['usageWindows']

/**
 * Rolling usage windows + overage context that work in both cloud and local
 * mode.
 *
 * In local mode the local API has no usage of its own: usage is metered
 * against the linked Shogo Cloud workspace, which the local API proxies via
 * `/api/local/cloud-billing/summary`. So local mode reads `plan.usageWindows`
 * from that summary; cloud mode keeps using `useBillingData`.
 */
export function useLocalAwareUsageWindows(workspaceId: string | undefined): {
  billing: BillingData
  usageWindows: UsageWindows
  overage: UsageOverageContext | undefined
  /** Re-fetch the cloud summary (no-op outside local mode). */
  refreshCloud: () => Promise<unknown>
} {
  const { localMode } = usePlatformConfig()
  const billing = useBillingData(workspaceId)
  const cloud = useCloudBillingSummary(localMode)
  const cloudPlan = cloud.summary?.plan

  return useMemo(() => {
    if (!localMode) {
      const balance = billing.effectiveBalance
      return {
        billing,
        usageWindows: billing.usageWindows,
        overage: balance
          ? {
              enabled: balance.overageEnabled,
              active: balance.overageActive,
              accumulatedUsd: balance.overageAccumulatedUsd,
            }
          : undefined,
        refreshCloud: noopRefresh,
      }
    }
    return {
      billing,
      usageWindows: cloudPlan?.usageWindows as UsageWindows,
      overage: cloudPlan
        ? {
            enabled: cloudPlan.overageEnabled === true,
            active: cloudPlan.overageActive,
            accumulatedUsd: cloudPlan.overageAccumulatedUsd ?? 0,
          }
        : undefined,
      refreshCloud: cloud.refresh,
    }
  }, [billing, cloud.refresh, cloudPlan, localMode])
}
