/**
 * useFormMetadata - Hook to get form metadata from meta-store
 *
 * Returns both JSON Schema (via model.toJsonSchema()) and Property entities
 * for building forms with JSON Forms library.
 *
 * Handles async schema loading - will load schema via metaStore.loadSchema() if not found.
 *
 * IMPORTANT: Uses autorun to ensure MobX computed views (model.properties) are
 * properly observed. Without this, the properties may appear empty on first render
 * due to timing issues between React render cycle and MobX reactivity.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { autorun } from "mobx"
import { useWavesmithMetaStore } from "@shogo/app-core"

export interface UseFormMetadataResult {
  /** JSON Schema generated from model.toJsonSchema() */
  jsonSchema: Record<string, any> | null
  /** Property entities from meta-store (for deriving UI schema) */
  properties: any[]
  /** The Model entity from meta-store */
  model: any | null
  /** Collection name derived from model (e.g., "requirementCollection") */
  collectionName: string | null
  /** True while schema is being loaded */
  loading: boolean
  /** Error message if schema/model not found */
  error: string | null
}

/**
 * Hook to get form metadata for a schema/model from the meta-store.
 *
 * First tries synchronous lookup, then falls back to async loading if not found.
 * Returns JSON Schema via model.toJsonSchema() for JSON Forms validation.
 *
 * Uses MobX autorun to ensure computed views (model.properties) are properly
 * observed and trigger re-renders when they change.
 *
 * @param schemaName - Schema name (e.g., "platform-features")
 * @param modelName - Model name (e.g., "Requirement")
 * @param workspace - Optional workspace/projectId for project-specific schema loading
 * @returns JSON Schema, property metadata, and model reference
 *
 * @example
 * ```tsx
 * const { jsonSchema, properties, model, collectionName, loading, error } = useFormMetadata(
 *   "platform-features",
 *   "Requirement",
 *   "project-123"  // Optional: project-specific workspace
 * )
 * // jsonSchema can be passed to JSON Forms
 * // properties can be used to derive UI Schema
 * ```
 */
export function useFormMetadata(
  schemaName: string | undefined,
  modelName: string | undefined,
  workspace?: string
): UseFormMetadataResult {
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

  // Track reactive metadata from MobX autorun
  // This ensures we re-render when model.properties changes
  const [metadata, setMetadata] = useState<{
    jsonSchema: Record<string, any> | null
    properties: any[]
    model: any | null
    collectionName: string | null
  }>({
    jsonSchema: null,
    properties: [],
    model: null,
    collectionName: null,
  })

  // Track whether schema was found (for triggering async load)
  const schemaFoundRef = useRef(false)

  // Lookup function - extracts data from MobX store
  const lookupMetadata = useCallback(() => {
    if (!schemaName || !modelName) {
      return { schema: null, model: null, jsonSchema: null, properties: [], collectionName: null }
    }

    const schema = metaStore.findSchemaByName(schemaName)
    if (!schema) {
      return { schema: null, model: null, jsonSchema: null, properties: [], collectionName: null }
    }

    const model = schema.models?.find((m: any) => m.name === modelName)
    if (!model) {
      return { schema, model: null, jsonSchema: null, properties: [], collectionName: null }
    }

    // Access model.properties INSIDE autorun to establish MobX tracking
    const properties = model.properties ?? []
    const jsonSchema = model.toJsonSchema ? model.toJsonSchema() : null
    const collectionName = model.collectionName ?? null

    return { schema, model, jsonSchema, properties, collectionName }
  }, [metaStore, schemaName, modelName])

  // Use autorun to observe MobX computed values and trigger re-renders
  useEffect(() => {
    if (!schemaName || !modelName) {
      schemaFoundRef.current = false
      setMetadata({
        jsonSchema: null,
        properties: [],
        model: null,
        collectionName: null,
      })
      return
    }

    // autorun will re-run whenever any observed MobX values change
    const dispose = autorun(() => {
      const result = lookupMetadata()

      schemaFoundRef.current = result.schema !== null

      // Update state if we have valid data
      // This triggers a React re-render
      setMetadata({
        jsonSchema: result.jsonSchema,
        properties: result.properties,
        model: result.model,
        collectionName: result.collectionName,
      })
    })

    return () => dispose()
  }, [schemaName, modelName, lookupMetadata])

  // Load schema async if not found
  useEffect(() => {
    // Skip if no schema name
    if (!schemaName) {
      setLoadingState({ loading: false, error: null, loadedSchemaName: null })
      return
    }

    // Skip if already found (schemaFoundRef is updated by autorun)
    if (schemaFoundRef.current) {
      setLoadingState((prev) => ({ ...prev, loading: false, loadedSchemaName: schemaName }))
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
        await metaStore.loadSchema(schemaName!, workspace)
        if (!cancelled) {
          // Don't set metadata here - autorun will pick up changes from loadSchema
          setLoadingState({ loading: false, error: null, loadedSchemaName: schemaName ?? null })
        }
      } catch (err: any) {
        if (!cancelled) {
          setLoadingState({
            loading: false,
            error: err.message ?? `Failed to load schema: ${schemaName}`,
            loadedSchemaName: schemaName ?? null,
          })
        }
      }
    }

    loadSchema()

    return () => {
      cancelled = true
    }
  }, [schemaName, workspace, metaStore, loadingState.loadedSchemaName])

  // Return early if no schema/model specified
  if (!schemaName || !modelName) {
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: false,
      error: null,
    }
  }

  // Return loading state while async loading
  if (loadingState.loading) {
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: true,
      error: null,
    }
  }

  // Return error if async loading failed
  if (loadingState.error) {
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: false,
      error: loadingState.error,
    }
  }

  // Check if we have valid metadata
  // This handles the case where schema is loaded but properties aren't populated yet
  const hasValidJsonSchema = metadata.jsonSchema &&
    typeof metadata.jsonSchema === 'object' &&
    metadata.jsonSchema.properties &&
    Object.keys(metadata.jsonSchema.properties).length > 0

  // If schema was loaded but JSON Schema doesn't have properties yet,
  // treat as still loading - MobX autorun will trigger update when ready
  if (loadingState.loadedSchemaName === schemaName && !hasValidJsonSchema && metadata.model) {
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: true,
      error: null,
    }
  }

  // Check for missing schema/model
  if (!metadata.model && loadingState.loadedSchemaName === schemaName) {
    // Schema load completed but model not found
    const schema = metaStore.findSchemaByName(schemaName)
    if (!schema) {
      return {
        jsonSchema: null,
        properties: [],
        model: null,
        collectionName: null,
        loading: false,
        error: `Schema not found: ${schemaName}`,
      }
    }
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: false,
      error: `Model "${modelName}" not found in schema "${schemaName}"`,
    }
  }

  // If we don't have metadata yet, still loading
  if (!metadata.jsonSchema || metadata.properties.length === 0) {
    return {
      jsonSchema: null,
      properties: [],
      model: null,
      collectionName: null,
      loading: true,
      error: null,
    }
  }

  return {
    jsonSchema: metadata.jsonSchema,
    properties: metadata.properties,
    model: metadata.model,
    collectionName: metadata.collectionName,
    loading: false,
    error: null,
  }
}
