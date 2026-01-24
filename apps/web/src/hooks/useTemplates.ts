/**
 * useTemplates - Shared hook for fetching SDK templates
 *
 * Features:
 * - Deduplication: Only one fetch happens even if multiple components mount simultaneously
 * - Caching: Templates are cached and shared across all components
 * - Error handling: Graceful fallback on fetch failure
 */

import { useState, useEffect, useRef } from 'react'
import type { TemplateMetadata } from '@/components/app/workspace/dashboard/TemplateCard'

// Re-export for convenience
export type { TemplateMetadata }

// Module-level cache for templates (shared across all instances)
let cachedTemplates: TemplateMetadata[] | null = null
let fetchPromise: Promise<TemplateMetadata[]> | null = null

/**
 * Fetch templates from the API with deduplication.
 * Multiple calls while a fetch is in progress will share the same promise.
 */
async function fetchTemplatesOnce(): Promise<TemplateMetadata[]> {
  // Return cached templates if available
  if (cachedTemplates !== null) {
    return cachedTemplates
  }

  // If a fetch is already in progress, return that promise
  if (fetchPromise !== null) {
    return fetchPromise
  }

  // Start a new fetch
  fetchPromise = (async () => {
    try {
      const response = await fetch('/api/templates')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()
      const templates = data.templates || []
      cachedTemplates = templates
      return templates
    } catch (error) {
      console.error('[useTemplates] Failed to fetch templates:', error)
      return []
    } finally {
      // Clear the promise after it resolves (allows retry on error)
      fetchPromise = null
    }
  })()

  return fetchPromise
}

/**
 * Hook to fetch and use templates.
 * Automatically deduplicates requests and caches results.
 */
export function useTemplates() {
  const [templates, setTemplates] = useState<TemplateMetadata[]>(cachedTemplates ?? [])
  const [isLoading, setIsLoading] = useState(cachedTemplates === null)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true

    // If we already have cached templates, use them immediately
    if (cachedTemplates !== null) {
      setTemplates(cachedTemplates)
      setIsLoading(false)
      return
    }

    // Fetch templates
    fetchTemplatesOnce().then((result) => {
      if (isMounted.current) {
        setTemplates(result)
        setIsLoading(false)
      }
    })

    return () => {
      isMounted.current = false
    }
  }, [])

  return { templates, isLoading }
}
