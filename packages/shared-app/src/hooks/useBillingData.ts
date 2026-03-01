/**
 * useBillingData Hook (shared)
 *
 * Provides billing data from the SDK domain store.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useSDKDomain } from "../domain"
import type { IDomainStore } from "@shogo/domain-stores"

export interface BillingDataState {
  subscription: any | undefined
  creditLedger: any | undefined
  effectiveBalance: {
    dailyCredits: number
    monthlyCredits: number
    rolloverCredits: number
    total: number
  } | undefined
  usageEvents: any[]
  hasActiveSubscription: boolean
  daysRemaining: number | undefined
  isLoading: boolean
  error: Error | null
  refetchSubscription: () => void
  refetchCreditLedger: () => void
  refetchUsageEvents: () => void
}

export function useBillingData(workspaceId: string | undefined): BillingDataState {
  const store = useSDKDomain() as IDomainStore

  const [isLoadingSubscription, setIsLoadingSubscription] = useState(false)
  const [isLoadingCreditLedger, setIsLoadingCreditLedger] = useState(false)
  const [isLoadingUsageEvents, setIsLoadingUsageEvents] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const [subscriptionRefetchCounter, setSubscriptionRefetchCounter] = useState(0)
  const [creditLedgerRefetchCounter, setCreditLedgerRefetchCounter] = useState(0)
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
    if (!workspaceId || !store?.creditLedgerCollection) { setIsLoadingCreditLedger(false); return }
    let cancelled = false
    setIsLoadingCreditLedger(true)
    store.creditLedgerCollection.loadAll({ workspaceId })
      .catch((err: any) => { if (!cancelled) setError(err instanceof Error ? err : new Error("Failed to load credit ledger")) })
      .finally(() => { if (!cancelled) setIsLoadingCreditLedger(false) })
    return () => { cancelled = true }
  }, [workspaceId, store, creditLedgerRefetchCounter])

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
  const refetchCreditLedger = useCallback(() => setCreditLedgerRefetchCounter((c) => c + 1), [])
  const refetchUsageEvents = useCallback(() => setUsageEventsRefetchCounter((c) => c + 1), [])

  const subsLength = store?.subscriptionCollection?.all?.length ?? 0
  const subscription = useMemo(() => {
    if (!workspaceId || !store?.subscriptionCollection) return undefined
    try {
      return store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)[0]
    } catch { return undefined }
  }, [workspaceId, store, isLoadingSubscription, subsLength])

  const ledgerLength = store?.creditLedgerCollection?.all?.length ?? 0
  const creditLedger = useMemo(() => {
    if (!workspaceId || !store?.creditLedgerCollection) return undefined
    try {
      return store.creditLedgerCollection.all.find((cl: any) => cl.workspaceId === workspaceId)
    } catch { return undefined }
  }, [workspaceId, store, isLoadingCreditLedger, ledgerLength])

  const effectiveBalance = useMemo(() => {
    if (!creditLedger) return undefined
    try {
      const lastReset = creditLedger.lastDailyReset ? new Date(creditLedger.lastDailyReset).toDateString() : ''
      const needsReset = lastReset !== new Date().toDateString()
      const daily = needsReset ? 5 : (creditLedger.dailyCredits ?? 0)
      const monthly = creditLedger.monthlyCredits ?? 0
      const rollover = creditLedger.rolloverCredits ?? 0
      return { dailyCredits: daily, monthlyCredits: monthly, rolloverCredits: rollover, total: daily + monthly + rollover }
    } catch { return undefined }
  }, [creditLedger])

  const usageEvents = useMemo(() => {
    if (!workspaceId || !store?.usageEventCollection) return []
    try {
      return store.usageEventCollection.all
        .filter((e: any) => e.workspaceId === workspaceId)
        .sort((a: any, b: any) => b.createdAt - a.createdAt)
        .slice(0, 50)
    } catch { return [] }
  }, [workspaceId, store, isLoadingUsageEvents])

  return {
    subscription,
    creditLedger,
    effectiveBalance,
    usageEvents,
    hasActiveSubscription: subscription?.status === 'active' || subscription?.status === 'trialing',
    daysRemaining: subscription?.daysRemaining,
    isLoading: isLoadingSubscription || isLoadingCreditLedger || isLoadingUsageEvents,
    error,
    refetchSubscription,
    refetchCreditLedger,
    refetchUsageEvents,
  }
}
