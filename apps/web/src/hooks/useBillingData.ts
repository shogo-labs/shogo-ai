/**
 * useBillingData Hook
 *
 * Provides billing data from the SDK domain store including:
 * - Subscriptions (Stripe subscription status per workspace)
 * - Credit Ledgers (credit balance tracking)
 * - Usage Events (credit usage history)
 *
 * Uses the SDK collections via collection.loadAll() methods.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useSDKDomain } from "../contexts/DomainProvider"
import { useSession } from "../contexts/SessionProvider"
import type { IDomainStore } from "../generated/domain"

/**
 * Return type for useBillingData hook
 */
export interface BillingDataState {
  /** Current workspace subscription (if any) */
  subscription: any | undefined
  /** Current workspace credit ledger */
  creditLedger: any | undefined
  /** Effective credit balance (with lazy daily reset applied) */
  effectiveBalance: {
    dailyCredits: number
    monthlyCredits: number
    rolloverCredits: number
    total: number
  } | undefined
  /** Recent usage events for current workspace */
  usageEvents: any[]
  /** Whether user has an active subscription */
  hasActiveSubscription: boolean
  /** Days remaining in current billing period */
  daysRemaining: number | undefined
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: Error | null
  /** Refetch subscription data */
  refetchSubscription: () => void
  /** Refetch credit ledger data */
  refetchCreditLedger: () => void
  /** Refetch usage events */
  refetchUsageEvents: () => void
}

/**
 * Hook for accessing billing data for the current workspace.
 *
 * @param workspaceId - The workspace to load billing data for
 *
 * @example
 * ```tsx
 * const { subscription, effectiveBalance, hasActiveSubscription } = useBillingData(workspaceId)
 *
 * if (!hasActiveSubscription) {
 *   return <UpgradeCTA />
 * }
 *
 * return <div>Credits: {effectiveBalance?.total ?? 0}</div>
 * ```
 */
export function useBillingData(workspaceId: string | undefined): BillingDataState {
  const { data: session } = useSession()
  const store = useSDKDomain() as IDomainStore

  // Loading states
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(false)
  const [isLoadingCreditLedger, setIsLoadingCreditLedger] = useState(false)
  const [isLoadingUsageEvents, setIsLoadingUsageEvents] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Refetch counters
  const [subscriptionRefetchCounter, setSubscriptionRefetchCounter] = useState(0)
  const [creditLedgerRefetchCounter, setCreditLedgerRefetchCounter] = useState(0)
  const [usageEventsRefetchCounter, setUsageEventsRefetchCounter] = useState(0)

  const userId = session?.user?.id

  // Load subscription data
  useEffect(() => {
    const loadSubscription = async () => {
      if (!workspaceId || !store?.subscriptionCollection) {
        setIsLoadingSubscription(false)
        return
      }

      try {
        setIsLoadingSubscription(true)
        setError(null)
        await store.subscriptionCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading subscription:", err)
        setError(err instanceof Error ? err : new Error("Failed to load subscription"))
      } finally {
        setIsLoadingSubscription(false)
      }
    }

    loadSubscription()
  }, [workspaceId, store, subscriptionRefetchCounter])

  // Load credit ledger data
  useEffect(() => {
    const loadCreditLedger = async () => {
      if (!workspaceId || !store?.creditLedgerCollection) {
        setIsLoadingCreditLedger(false)
        return
      }

      try {
        setIsLoadingCreditLedger(true)
        await store.creditLedgerCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading credit ledger:", err)
        setError(err instanceof Error ? err : new Error("Failed to load credit ledger"))
      } finally {
        setIsLoadingCreditLedger(false)
      }
    }

    loadCreditLedger()
  }, [workspaceId, store, creditLedgerRefetchCounter])

  // Load usage events
  useEffect(() => {
    const loadUsageEvents = async () => {
      if (!workspaceId || !store?.usageEventCollection) {
        setIsLoadingUsageEvents(false)
        return
      }

      try {
        setIsLoadingUsageEvents(true)
        await store.usageEventCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading usage events:", err)
        setError(err instanceof Error ? err : new Error("Failed to load usage events"))
      } finally {
        setIsLoadingUsageEvents(false)
      }
    }

    loadUsageEvents()
  }, [workspaceId, store, usageEventsRefetchCounter])

  // Refetch callbacks
  const refetchSubscription = useCallback(() => {
    setSubscriptionRefetchCounter((c) => c + 1)
  }, [])

  const refetchCreditLedger = useCallback(() => {
    setCreditLedgerRefetchCounter((c) => c + 1)
  }, [])

  const refetchUsageEvents = useCallback(() => {
    setUsageEventsRefetchCounter((c) => c + 1)
  }, [])

  // Get subscription for workspace
  const subscription = useMemo(() => {
    if (!workspaceId || !store?.subscriptionCollection) return undefined
    try {
      const subs = store.subscriptionCollection.all.filter((s: any) => s.workspaceId === workspaceId)
      return subs[0] // Return the first (and typically only) subscription
    } catch {
      return undefined
    }
  }, [workspaceId, store, isLoadingSubscription])

  // Get credit ledger for workspace
  const creditLedger = useMemo(() => {
    if (!workspaceId || !store?.creditLedgerCollection) return undefined
    try {
      return store.creditLedgerCollection.all.find((cl: any) => cl.workspaceId === workspaceId)
    } catch {
      return undefined
    }
  }, [workspaceId, store, isLoadingCreditLedger])

  // Compute effective balance from raw credit ledger fields
  const effectiveBalance = useMemo(() => {
    if (!creditLedger) return undefined
    try {
      const daily = creditLedger.dailyCredits ?? 0
      const monthly = creditLedger.monthlyCredits ?? 0
      const rollover = creditLedger.rolloverCredits ?? 0
      return {
        dailyCredits: daily,
        monthlyCredits: monthly,
        rolloverCredits: rollover,
        total: daily + monthly + rollover,
      }
    } catch {
      return undefined
    }
  }, [creditLedger])

  // Get recent usage events (last 50, sorted by createdAt desc)
  const usageEvents = useMemo(() => {
    if (!workspaceId || !store?.usageEventCollection) return []
    try {
      return store.usageEventCollection.all
        .filter((e: any) => e.workspaceId === workspaceId)
        .sort((a: any, b: any) => b.createdAt - a.createdAt)
        .slice(0, 50)
    } catch {
      return []
    }
  }, [workspaceId, store, isLoadingUsageEvents])

  // Computed helpers
  const hasActiveSubscription = subscription?.isActive ?? false
  const daysRemaining = subscription?.daysRemaining

  const isLoading = isLoadingSubscription || isLoadingCreditLedger || isLoadingUsageEvents

  return {
    subscription,
    creditLedger,
    effectiveBalance,
    usageEvents,
    hasActiveSubscription,
    daysRemaining,
    isLoading,
    error,
    refetchSubscription,
    refetchCreditLedger,
    refetchUsageEvents,
  }
}
