/**
 * useFeaturePolling - Hook for polling domain data
 *
 * Refreshes selected feature data at configurable intervals (default 25 seconds).
 * Uses SDK collections via collection.loadAll() methods.
 *
 * Note: Currently only supports featureSessionCollection from SDK.
 * Other collections (requirements, findings, etc.) are loaded via legacy domains.
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { useSDKDomain } from "../contexts/DomainProvider"
import type { IDomainStore } from "../generated/domain"

/**
 * Collections available in SDK for polling.
 * Only featureSessionCollection is currently generated.
 */
const SDK_FEATURE_COLLECTIONS = [
  "featureSessionCollection",
] as const

/** Supported domain names for polling */
export type PollableDomain = "platformFeatures" | "componentBuilder"

export interface UseFeaturePollingOptions {
  /** ID of the feature session to poll data for */
  featureId: string | null
  /** Polling interval in milliseconds (default: 25000) */
  interval?: number
  /** Whether polling is enabled (default: true) */
  enabled?: boolean
  /** Domains to sync (default: ["platformFeatures"]) */
  domainsToSync?: PollableDomain[]
}

export interface UseFeaturePollingResult {
  /** Whether the visual polling indicator should show (only on interval polls) */
  isPolling: boolean
  /** Timestamp of last successful refresh (null if never refreshed) */
  lastRefresh: number | null
  /** Manually trigger a silent refresh (no visual indicator) */
  refresh: () => Promise<void>
  /** Error from most recent polling attempt (null if successful) */
  error: Error | null
}

/**
 * Hook for polling platform-features domain data at regular intervals.
 *
 * @example
 * ```tsx
 * function FeatureDetails({ featureId }: { featureId: string }) {
 *   const { isPolling, lastRefresh, refresh, error } = useFeaturePolling({
 *     featureId,
 *     interval: 25000,
 *     enabled: true,
 *   })
 *
 *   return (
 *     <div>
 *       {isPolling && <span>Syncing...</span>}
 *       {error && <span>Error: {error.message}</span>}
 *       <button onClick={refresh}>Refresh Now</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useFeaturePolling({
  featureId,
  interval = 25000,
  enabled = true,
  domainsToSync = ["platformFeatures"],
}: UseFeaturePollingOptions): UseFeaturePollingResult {
  const [isPolling, setIsPolling] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)
  const [error, setError] = useState<Error | null>(null)

  // Access SDK domain store
  const store = useSDKDomain() as IDomainStore

  // Use ref to track if component is mounted (for cleanup safety)
  const isMountedRef = useRef(true)

  /**
   * Internal refresh function with control over visual indicator
   * @param showIndicator - Whether to show the visual polling indicator
   */
  const doRefresh = useCallback(async (showIndicator: boolean) => {
    if (!featureId || !store) {
      return
    }

    // Only show visual indicator for interval-based polls
    if (showIndicator) {
      setIsPolling(true)
    }
    setError(null)

    try {
      const refreshPromises: Promise<void>[] = []

      // Poll SDK collections that exist
      for (const collectionName of SDK_FEATURE_COLLECTIONS) {
        const collection = (store as any)[collectionName]
        if (collection?.loadAll && typeof collection.loadAll === "function") {
          // Load feature session data filtered by project (featureId is often used as projectId filter)
          refreshPromises.push(collection.loadAll({ projectId: featureId }))
        }
      }

      await Promise.all(refreshPromises)

      // Only update state if still mounted
      if (isMountedRef.current) {
        setLastRefresh(Date.now())
        setError(null)
      }
    } catch (err) {
      // Only update state if still mounted
      if (isMountedRef.current) {
        const errorObj = err instanceof Error ? err : new Error(String(err))
        setError(errorObj)
        console.error("[useFeaturePolling] Polling error:", err)
      }
    } finally {
      if (isMountedRef.current && showIndicator) {
        setIsPolling(false)
      }
    }
  }, [featureId, store])

  /**
   * Public refresh function - silent by default (no visual indicator)
   * Used by smart query triggers to refresh data without UI noise
   */
  const refresh = useCallback(() => doRefresh(false), [doRefresh])

  /**
   * Interval refresh - shows visual indicator
   */
  const intervalRefresh = useCallback(() => doRefresh(true), [doRefresh])

  // Set up polling interval
  useEffect(() => {
    isMountedRef.current = true

    // Don't poll if disabled or no featureId
    if (!enabled || !featureId) {
      return
    }

    // Initial refresh on mount/featureId change (silent)
    refresh()

    // Set up interval for subsequent polls (with visual indicator)
    const intervalId = setInterval(intervalRefresh, interval)

    // Cleanup on unmount or featureId/enabled change
    return () => {
      isMountedRef.current = false
      clearInterval(intervalId)
    }
  }, [featureId, interval, enabled, refresh, intervalRefresh])

  return {
    isPolling,
    lastRefresh,
    refresh,
    error,
  }
}
