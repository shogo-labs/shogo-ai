/**
 * useDataGridMetadata - Hook to get property metadata from meta-store
 *
 * Returns meta-store Property entities directly (no transformation needed).
 * Property entities are compatible with PropertyMetadata interface used by PropertyRenderer.
 *
 * Handles async schema loading - will load schema via metaStore.loadSchema() if not found.
 */

import { useState, useEffect, useMemo } from "react"
import { useWavesmithMetaStore } from "@shogo/app-core"

interface UseDataGridMetadataResult {
  /** Property entities from meta-store (compatible with PropertyMetadata) */
  properties: any[]
  /** Collection name derived from model (e.g., "requirementCollection") */
  collectionName: string | null
  /** True while schema is being loaded */
  loading: boolean
  /** Error message if schema/model not found */
  error: string | null
}

/**
 * Hook to get property metadata for a schema/model from the meta-store.
 *
 * First tries synchronous lookup, then falls back to async loading if not found.
 * Returns Property entities directly which are compatible with PropertyMetadata interface.
 *
 * @param schemaName - Schema name (e.g., "platform-features")
 * @param modelName - Model name (e.g., "Requirement")
 * @param workspace - Optional workspace/projectId for project-specific schema loading
 * @returns Property metadata and collection name
 *
 * @example
 * ```tsx
 * const { properties, collectionName, loading, error } = useDataGridMetadata(
 *   "platform-features",
 *   "Requirement",
 *   "project-123"  // Optional: project-specific workspace
 * )
 * // properties can be passed directly to PropertyRenderer
 * ```
 */
export function useDataGridMetadata(
  schemaName: string | undefined,
  modelName: string | undefined,
  workspace?: string
): UseDataGridMetadataResult {
  const metaStore = useWavesmithMetaStore()

  // Track async loading state
  const [loadingState, setLoadingState] = useState<{
    loading: boolean
    error: string | null
    loadedSchemaName: string | null
  }>({
    loading: false,
    error: null,
    loadedSchemaName: null,
  })

  // Try sync lookup first (reactive - will re-run when metaStore changes)
  const syncResult = useMemo(() => {
    if (!schemaName || !modelName) {
      return { schema: null, model: null, found: false }
    }
    const schema = metaStore.findSchemaByName(schemaName)
    if (!schema) {
      return { schema: null, model: null, found: false }
    }
    const model = schema.models?.find((m: any) => m.name === modelName)
    return { schema, model, found: true }
  }, [metaStore, schemaName, modelName])

  // Load schema async if not found in sync lookup
  useEffect(() => {
    // Skip if no schema name
    if (!schemaName) {
      setLoadingState({ loading: false, error: null, loadedSchemaName: null })
      return
    }

    // Skip if already found synchronously
    if (syncResult.found) {
      setLoadingState({ loading: false, error: null, loadedSchemaName: schemaName })
      return
    }

    // Skip if we already tried loading this schema (success or failure)
    if (loadingState.loadedSchemaName === schemaName) {
      return
    }

    let cancelled = false

    async function loadSchema() {
      setLoadingState({ loading: true, error: null, loadedSchemaName: null })
      try {
        // Pass workspace for project-specific schema loading
        await metaStore.loadSchema(schemaName, workspace)
        if (!cancelled) {
          setLoadingState({ loading: false, error: null, loadedSchemaName: schemaName })
        }
      } catch (err: any) {
        if (!cancelled) {
          setLoadingState({
            loading: false,
            error: err.message ?? `Failed to load schema: ${schemaName}`,
            loadedSchemaName: schemaName,
          })
        }
      }
    }

    loadSchema()

    return () => {
      cancelled = true
    }
  }, [schemaName, workspace, syncResult.found, metaStore, loadingState.loadedSchemaName])

  // Return early if no schema/model specified
  if (!schemaName || !modelName) {
    return { properties: [], collectionName: null, loading: false, error: null }
  }

  // Return loading state while async loading
  if (loadingState.loading) {
    return { properties: [], collectionName: null, loading: true, error: null }
  }

  // Return error if async loading failed
  if (loadingState.error) {
    return { properties: [], collectionName: null, loading: false, error: loadingState.error }
  }

  // Try sync lookup again (schema may have been loaded async)
  const schema = metaStore.findSchemaByName(schemaName)
  if (!schema) {
    return {
      properties: [],
      collectionName: null,
      loading: false,
      error: `Schema not found: ${schemaName}`,
    }
  }

  const model = schema.models?.find((m: any) => m.name === modelName)
  if (!model) {
    return {
      properties: [],
      collectionName: null,
      loading: false,
      error: `Model "${modelName}" not found in schema "${schemaName}"`,
    }
  }

  // Return Property entities directly - they have all fields PropertyMetadata needs:
  // name, type, format, enum, xReferenceType, xReferenceTarget, xComputed, xRenderer, required
  const properties = model.properties ?? []

  // DEBUG: Log properties to verify format and xRenderer are present
  if (properties.some((p: any) => p.name === "avatar" || p.name === "image")) {
    console.log("[useDataGridMetadata] Properties with image-related names:",
      properties.filter((p: any) => p.name === "avatar" || p.name === "image")
        .map((p: any) => ({ name: p.name, type: p.type, format: p.format, xRenderer: p.xRenderer }))
    )
  }

  return {
    properties,
    collectionName: model.collectionName ?? null,
    loading: false,
    error: null,
  }
}
