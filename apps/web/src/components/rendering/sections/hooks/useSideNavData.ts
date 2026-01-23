/**
 * useSideNavData - Hook for loading dynamic navigation items from Wavesmith stores
 *
 * Enables SideNavSection and AppShellSection to load sidebar items from any
 * Wavesmith schema/model combination with grouping, filtering, and ordering support.
 *
 * Follows the same patterns as useDataGridData but returns nav-specific structure.
 */

import { useState, useEffect, useMemo, useCallback } from "react"
import { useDomainStore } from "@shogo/app-core"

// ============================================================================
// Types
// ============================================================================

/**
 * Navigation item for sidebar
 */
export interface NavItem {
  id: string
  label: string
  href?: string
  icon?: string
  badge?: string | number
  disabled?: boolean
  /** Original entity data if loaded from dataSource */
  data?: Record<string, unknown>
}

interface DataSourceConfig {
  /** Schema name (e.g., "component-builder") */
  schema: string
  /** Model name (e.g., "ComponentDefinition") */
  model: string
  /** Field to use as nav item ID (default: "id") */
  idField?: string
  /** Field to use as nav item label (default: "name") */
  labelField?: string
  /** Field to use as nav item icon (optional) */
  iconField?: string
  /** Field to group items by (creates NavGroups) */
  groupBy?: string
  /** MongoDB-style filter */
  filter?: Record<string, any>
  /** Sort configuration */
  orderBy?: { field: string; direction: "asc" | "desc" }[]
}

interface NavGroup {
  type: "group"
  id: string
  label: string
  icon?: string
  items: NavItem[]
  defaultExpanded?: boolean
}

type NavEntry = NavItem | NavGroup

interface UseSideNavDataResult {
  /** Navigation items (flat or grouped) */
  items: NavEntry[]
  /** Flat list of all items (for lookup) */
  flatItems: NavItem[]
  /** True while async query is loading */
  loading: boolean
  /** Error message if query failed */
  error: string | null
  /** Function to trigger refetch */
  refetch: () => void
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert store name from model name
 * e.g., "ComponentDefinition" -> "componentDefinitionCollection"
 */
function modelToCollectionName(modelName: string): string {
  const camelCase = modelName.charAt(0).toLowerCase() + modelName.slice(1)
  return `${camelCase}Collection`
}

/**
 * Convert raw entity to NavItem
 */
function entityToNavItem(
  entity: any,
  idField: string,
  labelField: string,
  iconField?: string
): NavItem {
  return {
    id: String(entity[idField] ?? entity.id),
    label: String(entity[labelField] ?? entity.name ?? "Unknown"),
    icon: iconField ? entity[iconField] : undefined,
    // Store original entity data for access via context
    data: { ...entity },
  }
}

/**
 * Group items by a field value
 */
function groupItems(
  items: NavItem[],
  rawEntities: any[],
  groupByField: string,
  idField: string
): NavEntry[] {
  const groups = new Map<string, NavItem[]>()

  // Create entity lookup for accessing group field
  const entityMap = new Map(rawEntities.map((e) => [String(e[idField] ?? e.id), e]))

  for (const item of items) {
    const entity = entityMap.get(item.id)
    const groupValue = entity?.[groupByField] ?? "Other"
    const groupKey = String(groupValue)

    if (!groups.has(groupKey)) {
      groups.set(groupKey, [])
    }
    groups.get(groupKey)!.push(item)
  }

  // Convert to NavGroup entries
  const result: NavEntry[] = []
  for (const [groupLabel, groupItems] of groups) {
    result.push({
      type: "group",
      id: `group-${groupLabel.toLowerCase().replace(/\s+/g, "-")}`,
      label: groupLabel,
      items: groupItems,
      defaultExpanded: true,
    })
  }

  return result
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for loading navigation items from a Wavesmith store.
 *
 * @example
 * ```tsx
 * const { items, loading } = useSideNavData({
 *   schema: "component-builder",
 *   model: "ComponentDefinition",
 *   labelField: "name",
 *   groupBy: "category",
 *   orderBy: [{ field: "name", direction: "asc" }],
 * })
 * ```
 */
export function useSideNavData(dataSource?: DataSourceConfig): UseSideNavDataResult {
  // Early return if no dataSource configured
  if (!dataSource) {
    return {
      items: [],
      flatItems: [],
      loading: false,
      error: null,
      refetch: () => {},
    }
  }

  const {
    schema,
    model,
    idField = "id",
    labelField = "name",
    iconField,
    groupBy,
    filter,
    orderBy,
  } = dataSource

  // Get domain store by schema name
  const domainStore = useDomainStore(schema)
  const collectionName = modelToCollectionName(model)
  const collection = domainStore?.[collectionName]

  // Async state
  const [asyncState, setAsyncState] = useState<{
    rawData: any[]
    loading: boolean
    error: string | null
  }>({
    rawData: [],
    loading: false,
    error: null,
  })
  const [refetchKey, setRefetchKey] = useState(0)

  // Determine if we need async path (has filter or orderBy)
  const hasAsyncQuery = !!(filter || orderBy)

  // ============================================================================
  // SYNC PATH: Use MST views (reactive)
  // ============================================================================
  const syncData = useMemo(() => {
    if (hasAsyncQuery || !collection) return []

    // Use collection.all() for sync path
    if (collection.all) {
      return collection.all() ?? []
    }

    return []
  }, [collection, hasAsyncQuery])

  // ============================================================================
  // ASYNC PATH: Use query builder with useEffect
  // ============================================================================
  useEffect(() => {
    if (!hasAsyncQuery) {
      setAsyncState({ rawData: [], loading: false, error: null })
      return
    }

    if (!collection?.query) {
      setAsyncState({
        rawData: [],
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

        if (filter) {
          queryBuilder = queryBuilder.where(filter)
        }
        if (orderBy) {
          for (const { field, direction } of orderBy) {
            queryBuilder = queryBuilder.orderBy(field, direction)
          }
        }

        const results = await queryBuilder.toArray()

        if (!cancelled) {
          setAsyncState({ rawData: results, loading: false, error: null })
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
  }, [collection, filter, orderBy, refetchKey, hasAsyncQuery])

  // Refetch function
  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1)
  }, [])

  // ============================================================================
  // Transform raw data to nav items
  // ============================================================================
  const rawData = hasAsyncQuery ? asyncState.rawData : syncData

  const { items, flatItems } = useMemo(() => {
    if (!rawData.length) {
      return { items: [], flatItems: [] }
    }

    // Convert to flat NavItems
    const flatItems = rawData.map((entity: Record<string, unknown>) =>
      entityToNavItem(entity, idField, labelField, iconField)
    )

    // Group if groupBy field is specified
    let items: NavEntry[]
    if (groupBy) {
      items = groupItems(flatItems, rawData, groupBy, idField)
    } else {
      items = flatItems
    }

    return { items, flatItems }
  }, [rawData, idField, labelField, iconField, groupBy])

  return {
    items,
    flatItems,
    loading: hasAsyncQuery ? asyncState.loading : false,
    error: hasAsyncQuery ? asyncState.error : null,
    refetch,
  }
}
