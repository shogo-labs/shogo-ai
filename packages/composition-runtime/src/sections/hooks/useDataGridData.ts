/**
 * useDataGridData - Unified hook for sync and async data loading
 *
 * Handles two data loading patterns:
 * 1. SYNC: Uses MST views (all, where, findBySession) - reactive, safe in render
 * 2. ASYNC: Uses query builder with useEffect - for complex queries
 *
 * The hook automatically chooses the appropriate path based on config.
 */

import { useState, useEffect, useMemo, useCallback } from "react"
import { useDomainStore } from "@shogo/app-core"

interface QueryConfig {
  filter?: Record<string, any>
  orderBy?: { field: string; direction: "asc" | "desc" }[]
  skip?: number
  take?: number
}

interface UseDataGridDataOptions {
  /** Schema name (e.g., "platform-features") */
  schemaName: string | undefined
  /** Collection name from meta-store (e.g., "requirementCollection") */
  collectionName: string | null
  /** Session ID for filtering (uses findBySession if available) */
  sessionId?: string
  /** Static filter using collection.where() */
  staticFilter?: Record<string, any>
  /** Async query config - if present, uses query builder */
  query?: QueryConfig
}

interface UseDataGridDataResult {
  /** The loaded data array */
  data: any[]
  /** True while async query is loading */
  loading: boolean
  /** Error message if query failed */
  error: string | null
  /** Function to trigger refetch (async path only) */
  refetch: () => void
}

/**
 * Hook for loading data grid data with support for both sync and async patterns.
 *
 * **Sync Path** (default): Uses MST views which are reactive and safe in render
 * - `collection.findBySession(sessionId)` - when sessionId provided
 * - `collection.where(filter)` - when staticFilter provided
 * - `collection.all()` - fallback
 *
 * **Async Path** (when `query` config present): Uses query builder with useEffect
 * - Supports MongoDB-style filters, orderBy, skip, take
 * - Terminal operations (toArray) are async
 *
 * @example
 * ```tsx
 * // Sync - reactive to MST changes
 * const { data } = useDataGridData({
 *   schemaName: "studio-chat",
 *   collectionName: "chatSessionCollection",
 * })
 *
 * // Async - complex query
 * const { data, loading } = useDataGridData({
 *   schemaName: "platform-features",
 *   collectionName: "requirementCollection",
 *   query: {
 *     filter: { status: "accepted" },
 *     orderBy: [{ field: "priority", direction: "desc" }],
 *     take: 10,
 *   },
 * })
 * ```
 */
export function useDataGridData(options: UseDataGridDataOptions): UseDataGridDataResult {
  const { schemaName, collectionName, sessionId, staticFilter, query } = options

  // Get domain store by schema name (uses runtime lookup)
  const domainStore = useDomainStore(schemaName ?? "")
  const collection = collectionName ? domainStore?.[collectionName] : undefined

  const hasAsyncQuery = !!query

  // Async state (only used when query config is present)
  const [asyncState, setAsyncState] = useState<{
    data: any[]
    loading: boolean
    error: string | null
  }>({
    data: [],
    loading: false,
    error: null,
  })
  const [refetchKey, setRefetchKey] = useState(0)

  // ============================================================================
  // SYNC PATH: Use MST views (reactive, no useEffect needed)
  // ============================================================================
  const syncData = useMemo(() => {
    // Skip sync path if using async query
    if (hasAsyncQuery || !collection) return []

    // Priority: session filter > static filter > all
    if (sessionId && collection.findBySession) {
      return collection.findBySession(sessionId) ?? []
    }
    if (staticFilter && collection.where) {
      return collection.where(staticFilter) ?? []
    }
    if (collection.all) {
      return collection.all() ?? []
    }

    return []
  }, [collection, sessionId, staticFilter, hasAsyncQuery])

  // ============================================================================
  // ASYNC PATH: Use query builder with useEffect
  // ============================================================================
  useEffect(() => {
    // Skip if not using async query
    if (!hasAsyncQuery) {
      setAsyncState({ data: [], loading: false, error: null })
      return
    }

    // Check collection has query method
    if (!collection?.query) {
      setAsyncState({
        data: [],
        loading: false,
        error: collection ? "Collection does not support queries" : "Collection not found",
      })
      return
    }

    let cancelled = false

    async function executeQuery() {
      setAsyncState((s) => ({ ...s, loading: true, error: null }))

      try {
        let queryBuilder = collection.query()

        // Apply query config
        if (query?.filter) {
          queryBuilder = queryBuilder.where(query.filter)
        }
        if (query?.orderBy) {
          for (const { field, direction } of query.orderBy) {
            queryBuilder = queryBuilder.orderBy(field, direction)
          }
        }
        if (query?.skip) {
          queryBuilder = queryBuilder.skip(query.skip)
        }
        if (query?.take) {
          queryBuilder = queryBuilder.take(query.take)
        }

        // CRITICAL: toArray() is async!
        const results = await queryBuilder.toArray()

        if (!cancelled) {
          setAsyncState({ data: results, loading: false, error: null })
        }
      } catch (err: any) {
        if (!cancelled) {
          setAsyncState((s) => ({
            ...s,
            loading: false,
            error: err.message ?? "Query failed",
          }))
        }
      }
    }

    executeQuery()

    return () => {
      cancelled = true
    }
  }, [collection, query, refetchKey, hasAsyncQuery])

  // Refetch function for async path
  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1)
  }, [])

  // Return appropriate result based on path
  if (hasAsyncQuery) {
    return { ...asyncState, refetch }
  }

  return {
    data: syncData,
    loading: false,
    error: null,
    refetch,
  }
}
