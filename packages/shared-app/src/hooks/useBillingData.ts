// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useBillingData Hook (shared)
 *
 * Provides billing data from the SDK domain store. All values are in USD.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useSDKDomain, useSDKHttp } from "../domain"
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

export type PlanSource = "subscription" | "grant" | "free"

/** One rolling usage window as surfaced to the client. */
export interface UsageWindowView {
  kind: "five_hour" | "weekly"
  usedUsd: number
  /** `null` when the plan is uncapped (enterprise). */
  limitUsd: number | null
  /** 0..1 (0 for uncapped plans). */
  utilization: number
  /** ISO timestamp the window next resets, or `null` if not yet opened. */
  resetsAt: string | null
}

export interface UsageWindows {
  fiveHour: UsageWindowView
  weekly: UsageWindowView
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
  // The plan the workspace is effectively on right now. A paid Stripe
  // subscription wins; otherwise an active super-admin grant's `planId`
  // confers a tier; otherwise 'free'.
  effectivePlanId: string
  // Where the effective plan came from. Lets callers distinguish a grant
  // upgrade (no Stripe customer to send to portal) from a real subscription.
  planSource: PlanSource
  // Rolling 5-hour + weekly usage windows (time-gated "unlimited"). Undefined
  // until the workspace-plan endpoint resolves.
  usageWindows: UsageWindows | undefined
}

export function useBillingData(workspaceId: string | undefined): BillingDataState {
  const store = useSDKDomain() as IDomainStore
  const http = useSDKHttp()

  const [isLoadingSubscription, setIsLoadingSubscription] = useState(false)
  const [isLoadingUsageWallet, setIsLoadingUsageWallet] = useState(false)
  const [isLoadingUsageEvents, setIsLoadingUsageEvents] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const [subscriptionRefetchCounter, setSubscriptionRefetchCounter] = useState(0)
  const [usageWalletRefetchCounter, setUsageWalletRefetchCounter] = useState(0)
  const [usageEventsRefetchCounter, setUsageEventsRefetchCounter] = useState(0)

  // The /api/billing/workspace-plan endpoint resolves the *effective* plan
  // for the workspace: a paid Stripe subscription wins, otherwise an active
  // super-admin grant's `planId` confers the tier, otherwise 'free'. We
  // fetch it alongside the store-backed Subscription row because grants
  // are not persisted as Subscription rows but still need to surface in the
  // UI as the current plan.
  const [effectivePlan, setEffectivePlan] = useState<{ planId: string; source: PlanSource } | null>(null)
  const [usageWindows, setUsageWindows] = useState<UsageWindows | undefined>(undefined)

  useEffect(() => {
    if (!workspaceId || !store?.subscriptionCollection) { setIsLoadingSubscription(false); return }
    let cancelled = false
    setIsLoadingSubscription(true)
    setError(null)
    // Load the Prisma Subscription row (Stripe-backed) AND the effective
    // plan resolver in parallel. The effective resolver is the only place
    // grant-conferred tiers (planId set on workspace_grants) become visible
    // to the client.
    Promise.all([
      store.subscriptionCollection.loadAll({ workspaceId }),
      http
        .get<{ ok?: boolean; planId?: string; source?: PlanSource; usageWindows?: UsageWindows }>(
          `/api/billing/workspace-plan?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
        .then((res) => {
          if (cancelled) return
          const data = (res as any)?.data ?? res
          if (data && data.ok && typeof data.planId === "string") {
            setEffectivePlan({
              planId: data.planId,
              source: (data.source as PlanSource) ?? (data.planId === "free" ? "free" : "subscription"),
            })
            if (data.usageWindows) setUsageWindows(data.usageWindows as UsageWindows)
          }
        })
        .catch(() => {
          // Non-fatal: if the endpoint fails the UI just falls back to the
          // store-backed subscription view (current behavior pre-grants).
        }),
    ])
      .catch((err: any) => { if (!cancelled) setError(err instanceof Error ? err : new Error("Failed to load subscription")) })
      .finally(() => { if (!cancelled) setIsLoadingSubscription(false) })
    return () => { cancelled = true }
  }, [workspaceId, store, subscriptionRefetchCounter, http])

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
  const realSubscription = useMemo(() => {
    if (!workspaceId || !store?.subscriptionCollection) return undefined
    try {
      return store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)[0]
    } catch { return undefined }
  }, [workspaceId, store, isLoadingSubscription, subsLength])

  // When a super-admin grant confers a paid plan but no Stripe subscription
  // exists, synthesize a subscription-shaped object so the rest of the UI
  // (which everywhere uses `subscription?.planId`, `subscription?.seats`,
  // etc.) lights up correctly. The synthetic record is clearly marked with
  // `source: 'grant'` and lacks Stripe-specific fields (no stripeCustomerId,
  // no currentPeriodEnd) so portal/checkout buttons can opt-out cleanly.
  const subscription = useMemo<any | undefined>(() => {
    if (realSubscription) return realSubscription
    if (!workspaceId) return undefined
    if (!effectivePlan || effectivePlan.source !== "grant") return undefined
    return {
      workspaceId,
      planId: effectivePlan.planId,
      status: "active",
      seats: 1,
      billingInterval: null,
      source: "grant" as const,
    }
  }, [realSubscription, workspaceId, effectivePlan])

  const walletLength = (store as any)?.usageWalletCollection?.all?.length ?? 0
  const usageWallet = useMemo(() => {
    const coll = (store as any)?.usageWalletCollection
    if (!workspaceId || !coll) return undefined
    try {
      return coll.all.find((w: any) => w.workspaceId === workspaceId)
    } catch { return undefined }
  }, [workspaceId, store, isLoadingUsageWallet, walletLength])

  // Track mutable wallet fields so downstream memos recompute when the
  // MobX model is updated in-place (same reference, new property values).
  const walletUpdatedAt = usageWallet?.updatedAt ?? 0
  const walletOverageHardLimitUsd = usageWallet?.overageHardLimitUsd
  const walletOverageEnabled = usageWallet?.overageEnabled
  const walletOverageAccumulatedUsd = usageWallet?.overageAccumulatedUsd

  const effectiveBalance = useMemo<EffectiveBalance | undefined>(() => {
    if (!usageWallet) return undefined
    try {
      const lastReset = usageWallet.lastDailyReset ? new Date(usageWallet.lastDailyReset).toDateString() : ''
      const needsReset = lastReset !== new Date().toDateString()
      // The daily allowance is free-tier only. When the wallet hasn't
      // reset for today yet, show the optimistic post-reset amount so
      // the UI matches what `consumeUsage` will dispense — $1 for free,
      // $0 for paid plans.
      const planId = (effectivePlan?.planId ?? '').toLowerCase()
      const isFreeTier = planId === '' || planId.startsWith('free')
      const optimisticDaily = isFreeTier ? 1 : 0
      const daily = needsReset ? optimisticDaily : (usageWallet.dailyIncludedUsd ?? 0)
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
  }, [usageWallet, effectivePlan, walletUpdatedAt, walletOverageHardLimitUsd, walletOverageEnabled, walletOverageAccumulatedUsd])

  const usageEvents = useMemo(() => {
    if (!workspaceId || !store?.usageEventCollection) return []
    try {
      return store.usageEventCollection.all
        .filter((e: any) => e.workspaceId === workspaceId)
        .sort((a: any, b: any) => b.createdAt - a.createdAt)
        .slice(0, 50)
    } catch { return [] }
  }, [workspaceId, store, isLoadingUsageEvents])

  // Resolve the effective plan + source once, with the synthetic
  // subscription (if any) and the server's effective resolver as fallbacks.
  const effectivePlanId = effectivePlan?.planId ?? subscription?.planId ?? "free"
  const planSource: PlanSource =
    effectivePlan?.source ?? (realSubscription ? "subscription" : "free")

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
    effectivePlanId,
    planSource,
    usageWindows,
  }
}
