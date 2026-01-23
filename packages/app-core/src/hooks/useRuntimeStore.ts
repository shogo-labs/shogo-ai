/**
 * useRuntimeStore - Universal store access with metastore fallback
 *
 * This hook provides a unified way to access stores by schema name:
 * 1. First tries DomainProvider (code-based domain stores)
 * 2. Falls back to metastore runtime stores (dynamically loaded schemas)
 *
 * This enables sections (DataGridSection, FormSection, etc.) to work with
 * both statically-defined domains AND dynamically-created schemas via MCP.
 *
 * Usage:
 * ```tsx
 * function MySection({ schemaName, model }) {
 *   const { store, loading, error, loadSchema } = useRuntimeStore(schemaName)
 *   const collection = store?.[`${model}Collection`]
 *   // ...
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { useOptionalDomainStore } from "../domain/DomainProvider"
import { useOptionalWavesmithMetaStore } from "../meta/WavesmithMetaStoreContext"

interface UseRuntimeStoreResult {
  /** The runtime store (from domain or metastore) */
  store: any | undefined
  /** True while loading schema from metastore */
  loading: boolean
  /** Error message if schema load failed */
  error: string | null
  /** Source of the store: 'domain', 'metastore', or null if not found */
  source: "domain" | "metastore" | null
  /** Manually trigger schema load (useful for retry) */
  loadSchema: () => Promise<void>
}

/**
 * Hook to get a runtime store by schema name with automatic fallback.
 *
 * Resolution order:
 * 1. Check DomainProvider for code-based domain store
 * 2. Check metastore for already-loaded schema
 * 3. Attempt to load schema via metastore.loadSchema()
 *
 * @param schemaName - The schema name (e.g., "platform-features", "crm-proj-123")
 * @returns Store, loading state, and source indicator
 */
export function useRuntimeStore(schemaName: string | undefined): UseRuntimeStoreResult {
  // Try domain store first (code-based, always preferred)
  const domainStore = useOptionalDomainStore(schemaName ?? "")
  const metaStore = useOptionalWavesmithMetaStore()

  // Use ref to access metaStore without adding to dependencies (prevents infinite loops)
  const metaStoreRef = useRef(metaStore)
  metaStoreRef.current = metaStore

  // Track which schema we've already tried to load (prevents re-triggering)
  const loadedSchemaRef = useRef<string | null>(null)

  const [state, setState] = useState<{
    metaRuntimeStore: any | undefined
    loading: boolean
    error: string | null
  }>({
    metaRuntimeStore: undefined,
    loading: false,
    error: null,
  })

  // Load schema from metastore if needed
  const loadSchema = useCallback(async () => {
    const ms = metaStoreRef.current
    if (!schemaName || !ms) return

    // Check if already loaded
    const existingSchema = ms.findSchemaByName?.(schemaName)
    if (existingSchema?.runtimeStore) {
      setState({
        metaRuntimeStore: existingSchema.runtimeStore,
        loading: false,
        error: null,
      })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))

    try {
      const schema = await ms.loadSchema(schemaName)
      if (schema?.runtimeStore) {
        setState({
          metaRuntimeStore: schema.runtimeStore,
          loading: false,
          error: null,
        })
      } else {
        setState({
          metaRuntimeStore: undefined,
          loading: false,
          error: `Schema "${schemaName}" loaded but has no runtime store`,
        })
      }
    } catch (err: any) {
      setState({
        metaRuntimeStore: undefined,
        loading: false,
        error: err.message ?? `Failed to load schema "${schemaName}"`,
      })
    }
  }, [schemaName]) // Only depend on schemaName, access metaStore via ref

  // Auto-load from metastore if domain store not available
  useEffect(() => {
    // Skip if no schema name or domain store exists
    if (!schemaName || domainStore) return

    const ms = metaStoreRef.current

    // Skip if no metastore available
    if (!ms) {
      setState({
        metaRuntimeStore: undefined,
        loading: false,
        error: "No metastore available for dynamic schema loading",
      })
      return
    }

    // Skip if we already tried loading this schema
    if (loadedSchemaRef.current === schemaName) return
    loadedSchemaRef.current = schemaName

    // Check if already loaded in metastore
    const existingSchema = ms.findSchemaByName?.(schemaName)
    if (existingSchema?.runtimeStore) {
      setState({
        metaRuntimeStore: existingSchema.runtimeStore,
        loading: false,
        error: null,
      })
      return
    }

    // Load schema
    loadSchema()
  }, [schemaName, domainStore]) // Removed metaStore and loadSchema - use refs instead

  // Return domain store if available (preferred)
  if (domainStore) {
    return {
      store: domainStore,
      loading: false,
      error: null,
      source: "domain",
      loadSchema,
    }
  }

  // Return metastore runtime if available
  if (state.metaRuntimeStore) {
    return {
      store: state.metaRuntimeStore,
      loading: false,
      error: null,
      source: "metastore",
      loadSchema,
    }
  }

  // Still loading or errored
  return {
    store: undefined,
    loading: state.loading,
    error: state.error,
    source: null,
    loadSchema,
  }
}

/**
 * Hook to get a specific collection from a runtime store.
 *
 * Convenience wrapper that combines useRuntimeStore with collection lookup.
 *
 * @param schemaName - The schema name
 * @param modelName - The model name (e.g., "Deal", "Contact")
 * @returns Collection with all standard methods (all, where, query, insertOne, etc.)
 */
export function useRuntimeCollection(
  schemaName: string | undefined,
  modelName: string | undefined
) {
  const { store, loading, error, source, loadSchema } = useRuntimeStore(schemaName)

  // Derive collection name from model name
  const collectionName = modelName ? `${modelName}Collection` : undefined
  const collection = collectionName ? store?.[collectionName] : undefined

  return {
    collection,
    store,
    loading,
    error,
    source,
    loadSchema,
  }
}
