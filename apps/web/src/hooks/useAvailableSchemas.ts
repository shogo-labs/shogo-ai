/**
 * useAvailableSchemas - Hook for listing available schemas via MCP
 *
 * Provides a lightweight way to populate schema dropdowns without loading
 * full schema data. Uses the mcpService's listSchemas() method
 * which calls the MCP schema.list tool.
 *
 * For loading a schema's models and properties, use metaStore.loadSchema()
 * after selecting a schema.
 */

import { useEffect, useState } from 'react'
import { mcpService } from '@/services'

interface UseAvailableSchemasResult {
  /** List of available schema names */
  schemas: string[]
  /** Whether schemas are currently loading */
  loading: boolean
  /** Error if schema listing failed */
  error: Error | null
  /** Refresh the schema list */
  refresh: () => void
}

/**
 * Hook to get available schema names for dropdown population.
 *
 * This is a lightweight operation that just lists schema names from disk
 * without loading full schema definitions.
 *
 * @example
 * ```tsx
 * function SchemaDropdown() {
 *   const { schemas, loading, error } = useAvailableSchemas()
 *
 *   if (loading) return <Spinner />
 *   if (error) return <ErrorMessage error={error} />
 *
 *   return (
 *     <Select>
 *       {schemas.map(name => (
 *         <SelectItem key={name} value={name}>{name}</SelectItem>
 *       ))}
 *     </Select>
 *   )
 * }
 * ```
 */
export function useAvailableSchemas(): UseAvailableSchemasResult {
  const [schemas, setSchemas] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    let mounted = true

    const loadSchemas = async () => {
      try {
        setLoading(true)
        const schemaNames = await mcpService.listSchemas()
        if (mounted) {
          setSchemas(schemaNames)
          setError(null)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Failed to list schemas'))
          setSchemas([])
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    loadSchemas()

    return () => {
      mounted = false
    }
  }, [refreshTrigger])

  const refresh = () => setRefreshTrigger(prev => prev + 1)

  return { schemas, loading, error, refresh }
}

export default useAvailableSchemas
