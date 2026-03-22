// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useFeaturePolling - Hook for polling domain data (shared)
 *
 * Refreshes selected feature data at configurable intervals.
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { useSDKDomain } from "../domain"
import type { IDomainStore } from "@shogo/domain-stores"

const SDK_FEATURE_COLLECTIONS = ["featureSessionCollection"] as const

export type PollableDomain = "platformFeatures" | "componentBuilder"

export interface UseFeaturePollingOptions {
  featureId: string | null
  interval?: number
  enabled?: boolean
  domainsToSync?: PollableDomain[]
}

export interface UseFeaturePollingResult {
  isPolling: boolean
  lastRefresh: number | null
  refresh: () => Promise<void>
  error: Error | null
}

export function useFeaturePolling({
  featureId,
  interval = 25000,
  enabled = true,
}: UseFeaturePollingOptions): UseFeaturePollingResult {
  const [isPolling, setIsPolling] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const store = useSDKDomain() as IDomainStore
  const isMountedRef = useRef(true)

  const doRefresh = useCallback(async (showIndicator: boolean) => {
    if (!featureId || !store) return
    if (showIndicator) setIsPolling(true)
    setError(null)
    try {
      const promises: Promise<void>[] = []
      for (const name of SDK_FEATURE_COLLECTIONS) {
        const collection = (store as any)[name]
        if (collection?.loadAll && typeof collection.loadAll === "function") {
          promises.push(collection.loadAll({ projectId: featureId }))
        }
      }
      await Promise.all(promises)
      if (isMountedRef.current) { setLastRefresh(Date.now()); setError(null) }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      if (isMountedRef.current && showIndicator) setIsPolling(false)
    }
  }, [featureId, store])

  const refresh = useCallback(() => doRefresh(false), [doRefresh])
  const intervalRefresh = useCallback(() => doRefresh(true), [doRefresh])

  useEffect(() => {
    isMountedRef.current = true
    if (!enabled || !featureId) return
    refresh()
    const id = setInterval(intervalRefresh, interval)
    return () => { isMountedRef.current = false; clearInterval(id) }
  }, [featureId, interval, enabled, refresh, intervalRefresh])

  return { isPolling, lastRefresh, refresh, error }
}
