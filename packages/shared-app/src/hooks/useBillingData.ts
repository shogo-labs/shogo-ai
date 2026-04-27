// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useBillingData Hook (shared)
 *
 * Provides billing data from the SDK domain store. All values are in USD.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useSDKDomain } from "../domain"
import type { IDomainStore } from "@shogo/domain-stores"

export interface EffectiveBalance {
  dailyIncludedUsd: number
  monthlyIncludedUsd: number
  monthlyIncludedAllocationUsd: number
  overageAccumulatedUsd: number
  overageEnabled: boolean
  overageHardLimitUsd: number | null
  total: number
}

export interface BillingDataState {
  subscription: any | undefined
  usageWallet: any | undefined
  effectiveBalance: EffectiveBalance | undefined
  usageEvents: any[]
  hasActiveSubscription: boolean
  hasAdvancedModelAccess: boolean
  daysRemaining: number | undefined
  isLoading: boolean
  error: Error | null
  refetchSubscription: () => void
  refetchUsageWallet: () => void
  refetchUsageEvents: () => void
}

export function useBillingData(workspaceId: string | undefined): BillingDataState {
  const store = useSDKDomain() as IDomainStore

  const [isLoadingSubscription, setIsLoadingSubscription] = useState(false)
  const [isLoadingUsageWallet, setIsLoadingUsageWallet] = useState(false)
  const [isLoadingUsageEvents, setIsLoadingUsageEvents] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const [subscriptionRefetchCounter, setSubscriptionRefetchCounter] = useState(0)
  const [usageWalletRefetchCounter, setUsageWalletRefetchCounter] = useState(0)
  const [usageEventsRefetchCounter, setUsageEventsRefetchCounter] = useState(0)

  useEffect(() => {
    if (!workspaceId || !store?.subscriptionCollection) { setIsLoadingSubscription(false); return }
    let cancelled = false
    setIsLoadingSubscription(true)
    setError(null)
    store.subscriptionCollection.loadAll({ workspaceId })
      .catch((err: any) => { if (!cancelled) setError(err instanceof Error ? err : new Error("Failed to load subscription")) })
      .finally(() => { if (!cancelled) setIsLoadingSubscription(false) })
    return () => { cancelled = true }
  }, [workspaceId, store, subscriptionRefetchCounter])

  useEffect(() => {
    const wallet = (store as any)?.usageWalletCollection
    if (!workspaceId || !wallet) { setIsLoadingUsageWallet(false); return }
    let cancelled = false
    setIsLoadingUsageWallet(true)
    wallet.loadAll({ workspaceId })
      .catch((err: any) => { if (!cancelled) setError(err instanceof Error ? err : new Error("Failed to load usage wallet")) })
      .finally(() => { if (!cancelled) setIsLoadingUsageWallet(false) })
    return () => { cancelled = true }
  }, [workspaceId, store, usageWalletRefetchCounter])

  useEffect(() => {
    if (!workspaceId || !store?.usageEventCollection) { setIsLoadingUsageEvents(false); return }
    let cancelled = false
    setIsLoadingUsageEvents(true)
    store.usageEventCollection.loadAll({ workspaceId })
      .catch((err: any) => { if (!cancelled) setError(err instanceof Error ? err : new Error("Failed to load usage events")) })
      .finally(() => { if (!cancelled) setIsLoadingUsageEvents(false) })
    return () => { cancelled = true }
  }, [workspaceId, store, usageEventsRefetchCounter])

  const refetchSubscription = useCallback(() => setSubscriptionRefetchCounter((c) => c + 1), [])
  const refetchUsageWallet = useCallback(() => setUsageWalletRefetchCounter((c) => c + 1), [])
  const refetchUsageEvents = useCallback(() => setUsageEventsRefetchCounter((c) => c + 1), [])

  const subsLength = store?.subscriptionCollection?.all?.length ?? 0
  const subscription = useMemo(() => {
    if (!workspaceId || !store?.subscriptionCollection) return undefined
    try {
      return store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)[0]
    } catch { return undefined }
  }, [workspaceId, store, isLoadingSubscription, subsLength])

  const walletLength = (store as any)?.usageWalletCollection?.all?.length ?? 0
  const usageWallet = useMemo(() => {
    const coll = (store as any)?.usageWalletCollection
    if (!workspaceId || !coll) return undefined
    try {
      return coll.all.find((w: any) => w.workspaceId === workspaceId)
    } catch { return undefined }
  }, [workspaceId, store, isLoadingUsageWallet, walletLength])

  const effectiveBalance = useMemo<EffectiveBalance | undefined>(() => {
    if (!usageWallet) return undefined
    try {
      const lastReset = usageWallet.lastDailyReset ? new Date(usageWallet.lastDailyReset).toDateString() : ''
      const needsReset = lastReset !== new Date().toDateString()
      const daily = needsReset ? 0.50 : (usageWallet.dailyIncludedUsd ?? 0)
      const monthly = usageWallet.monthlyIncludedUsd ?? 0
      const monthlyAllocation = usageWallet.monthlyIncludedAllocationUsd ?? 0
      const overageAccumulated = usageWallet.overageAccumulatedUsd ?? 0
      const overageEnabled = usageWallet.overageEnabled === true
      const overageHardLimit = typeof usageWallet.overageHardLimitUsd === 'number' ? usageWallet.overageHardLimitUsd : null
      return {
        dailyIncludedUsd: daily,
        monthlyIncludedUsd: monthly,
        monthlyIncludedAllocationUsd: monthlyAllocation,
        overageAccumulatedUsd: overageAccumulated,
        overageEnabled,
        overageHardLimitUsd: overageHardLimit,
        total: daily + monthly,
      }
    } catch { return undefined }
  }, [usageWallet])

  const usageEvents = useMemo(() => {
    if (!workspaceId || !store?.usageEventCollection) return []
    try {
      return store.usageEventCollection.all
        .filter((e: any) => e.workspaceId === workspaceId)
        .sort((a: any, b: any) => b.createdAt - a.createdAt)
        .slice(0, 50)
    } catch { return [] }
  }, [workspaceId, store, isLoadingUsageEvents])

  const hasActiveSubscription = subscription?.status === 'active' || subscription?.status === 'trialing'
  const hasAdvancedModelAccess = hasActiveSubscription && subscription?.planId !== 'basic'

  return {
    subscription,
    usageWallet,
    effectiveBalance,
    usageEvents,
    hasActiveSubscription,
    hasAdvancedModelAccess,
    daysRemaining: subscription?.daysRemaining,
    isLoading: isLoadingSubscription || isLoadingUsageWallet || isLoadingUsageEvents,
    error,
    refetchSubscription,
    refetchUsageWallet,
    refetchUsageEvents,
  }
}
