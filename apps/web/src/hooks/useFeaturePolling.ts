/**
 * useFeaturePolling - Hook for polling domain data
 *
 * Refreshes selected feature data at configurable intervals (default 25 seconds).
 * Uses domain collections via useDomains() and triggers MST collection refresh
 * via query().toArray() pattern which auto-syncs from remote via syncFromRemote.
 *
 * Supports polling multiple domains (platformFeatures, componentBuilder, etc.)
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { useDomains } from "../contexts/DomainProvider"

/**
 * Default collections to poll from platformFeatures domain.
 * Each collection has a query() method that returns data from the backend
 * and auto-syncs to MST via the remote executor's syncFromRemote callback.
 */
const PLATFORM_FEATURES_COLLECTIONS = [
  "featureSessionCollection",
  "requirementCollection",
  "analysisFindingCollection",
  "designDecisionCollection",
  "implementationTaskCollection",
  "testSpecificationCollection",
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

  // Access all domains from DomainProvider
  // Using `any` type to match codebase pattern and avoid DomainsMap constraint issues
  const domains = useDomains<{ platformFeatures: any; componentBuilder: any }>()

  // Use ref to track if component is mounted (for cleanup safety)
  const isMountedRef = useRef(true)

  /**
   * Internal refresh function with control over visual indicator
   * @param showIndicator - Whether to show the visual polling indicator
   */
  const doRefresh = useCallback(async (showIndicator: boolean) => {
    if (!featureId) {
      return
    }

    // Only show visual indicator for interval-based polls
    if (showIndicator) {
      setIsPolling(true)
    }
    setError(null)

    try {
      const refreshPromises: Promise<void>[] = []

      // Iterate over each domain to sync
      for (const domainName of domainsToSync) {
        const domain = domains[domainName]
        if (!domain) continue

        if (domainName === "platformFeatures") {
          // Use predefined list for platformFeatures (feature-specific collections)
          for (const collectionName of PLATFORM_FEATURES_COLLECTIONS) {
            const collection = domain[collectionName]
            if (collection?.query && typeof collection.query === "function") {
              refreshPromises.push(collection.query().toArray())
            }
          }
        } else {
          // For other domains (componentBuilder), poll all collections dynamically
          const collectionNames = Object.keys(domain).filter(k => k.endsWith("Collection"))
          for (const collectionName of collectionNames) {
            const collection = domain[collectionName]
            if (collection?.query && typeof collection.query === "function") {
              refreshPromises.push(collection.query().toArray())
            }
          }
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
  }, [featureId, domains, domainsToSync])

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
