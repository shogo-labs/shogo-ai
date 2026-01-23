/**
 * useSchemaData Hook
 * Task: task-2-3c-003
 *
 * Custom hook for loading schema data via mcpService.
 *
 * Per design-2-3c-006:
 * - Returns { models, isLoading, error, refetch }
 * - Handles null/undefined schemaName gracefully
 * - Cleanup handles component unmount during async load
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { mcpService } from "@/services"

/**
 * Schema field type
 */
export interface SchemaField {
  name: string
  type: string
  required?: boolean
  "x-mst-type"?: "identifier" | "reference" | "maybe-reference"
  "x-reference-type"?: "single" | "array"
  "x-arktype"?: string
  "x-computed"?: boolean
}

/**
 * Schema model type - matches mcpService.loadSchema response
 */
export interface SchemaModel {
  name: string
  collectionName: string
  fields: SchemaField[]
}

/**
 * Return type for useSchemaData hook
 */
export interface UseSchemaDataResult {
  models: SchemaModel[] | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

/**
 * useSchemaData Hook
 *
 * Loads schema data via mcpService and manages loading/error states.
 *
 * @param schemaName - Name of schema to load, or null/undefined for no-op
 * @param workspace - Optional workspace/projectId to load schema from (defaults to 'workspace')
 * @returns { models, isLoading, error, refetch }
 */
export function useSchemaData(
  schemaName: string | null | undefined,
  workspace?: string | null
): UseSchemaDataResult {
  const [models, setModels] = useState<SchemaModel[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true)

  // Load schema data
  const loadSchema = useCallback(async (name: string, ws?: string | null) => {
    if (!isMountedRef.current) return

    setIsLoading(true)
    setError(null)

    try {
      // Pass workspace to loadSchema for project-specific schema loading
      const result = await mcpService.loadSchema(name, ws || undefined)

      if (!isMountedRef.current) return

      if (result.ok && result.models) {
        setModels(result.models)
      } else {
        setError(new Error(`Failed to load schema: ${name}`))
        setModels(null)
      }
    } catch (err) {
      if (!isMountedRef.current) return

      setError(err instanceof Error ? err : new Error(String(err)))
      setModels(null)
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [])

  // Refetch function for retry on error
  const refetch = useCallback(() => {
    if (schemaName) {
      loadSchema(schemaName, workspace)
    }
  }, [schemaName, workspace, loadSchema])

  // Effect to load schema when schemaName or workspace changes
  useEffect(() => {
    isMountedRef.current = true

    // Handle null/undefined schemaName gracefully
    if (!schemaName) {
      setModels(null)
      setIsLoading(false)
      setError(null)
      return
    }

    loadSchema(schemaName, workspace)

    // Cleanup function to handle unmount during async load
    return () => {
      isMountedRef.current = false
    }
  }, [schemaName, workspace, loadSchema])

  return {
    models,
    isLoading,
    error,
    refetch,
  }
}
