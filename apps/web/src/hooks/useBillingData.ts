/**
 * useBillingData Hook
 *
 * Provides billing data from the billing domain store including:
 * - Subscriptions (Stripe subscription status per workspace)
 * - Credit Ledgers (credit balance tracking)
 * - Usage Events (credit usage history)
 *
 * Uses the API persistence layer via collection.loadAll() methods.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useDomains } from "../contexts/DomainProvider"
import { useSession } from "../auth/client"

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
  const { billing } = useDomains()

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
      if (!workspaceId || !billing?.subscriptionCollection) {
        setIsLoadingSubscription(false)
        return
      }

      try {
        setIsLoadingSubscription(true)
        setError(null)
        await billing.subscriptionCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading subscription:", err)
        setError(err instanceof Error ? err : new Error("Failed to load subscription"))
      } finally {
        setIsLoadingSubscription(false)
      }
    }

    loadSubscription()
  }, [workspaceId, billing, subscriptionRefetchCounter])

  // Load credit ledger data
  useEffect(() => {
    const loadCreditLedger = async () => {
      if (!workspaceId || !billing?.creditLedgerCollection) {
        setIsLoadingCreditLedger(false)
        return
      }

      try {
        setIsLoadingCreditLedger(true)
        await billing.creditLedgerCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading credit ledger:", err)
        setError(err instanceof Error ? err : new Error("Failed to load credit ledger"))
      } finally {
        setIsLoadingCreditLedger(false)
      }
    }

    loadCreditLedger()
  }, [workspaceId, billing, creditLedgerRefetchCounter])

  // Load usage events
  useEffect(() => {
    const loadUsageEvents = async () => {
      if (!workspaceId || !billing?.usageEventCollection) {
        setIsLoadingUsageEvents(false)
        return
      }

      try {
        setIsLoadingUsageEvents(true)
        await billing.usageEventCollection.loadAll({ workspaceId })
      } catch (err) {
        console.error("[useBillingData] Error loading usage events:", err)
        setError(err instanceof Error ? err : new Error("Failed to load usage events"))
      } finally {
        setIsLoadingUsageEvents(false)
      }
    }

    loadUsageEvents()
  }, [workspaceId, billing, usageEventsRefetchCounter])

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
    if (!workspaceId || !billing?.subscriptionCollection) return undefined
    try {
      const subs = billing.subscriptionCollection.findByWorkspace(workspaceId)
      return subs[0] // Return the first (and typically only) subscription
    } catch {
      return undefined
    }
  }, [workspaceId, billing, isLoadingSubscription])

  // Get credit ledger for workspace
  const creditLedger = useMemo(() => {
    if (!workspaceId || !billing?.creditLedgerCollection) return undefined
    try {
      return billing.creditLedgerCollection.findByWorkspace(workspaceId)
    } catch {
      return undefined
    }
  }, [workspaceId, billing, isLoadingCreditLedger])

  // Get effective balance (computed view from domain)
  const effectiveBalance = useMemo(() => {
    if (!creditLedger) return undefined
    try {
      return creditLedger.effectiveBalance
    } catch {
      return undefined
    }
  }, [creditLedger])

  // Get recent usage events
  const usageEvents = useMemo(() => {
    if (!workspaceId || !billing?.usageEventCollection) return []
    try {
      return billing.usageEventCollection.recentForWorkspace(workspaceId, 50)
    } catch {
      return []
    }
  }, [workspaceId, billing, isLoadingUsageEvents])

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
