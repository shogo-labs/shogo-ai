/**
 * useSchemaPreview - Hook for loading schema and runtime store in Unit3
 *
 * Encapsulates the pattern from HostMSTDemo for dynamic schema loading:
 * 1. Load schema via metaStore.loadSchema()
 * 2. Get runtime store from cache via getRuntimeStore()
 * 3. Load data for all collections
 */

import { useState, useEffect } from 'react'
import { useWavesmithMetaStore } from '../contexts/WavesmithMetaStoreContext'
import { getRuntimeStore } from '@shogo/state-api'

export interface SchemaPreviewState {
  schema: any | null
  runtimeStore: any | null
  /** Cached models array - avoids MST computed view issues */
  models: any[]
  loading: boolean
  error: string | null
}

/**
 * Hook to load a schema and its runtime store for preview.
 * Returns schema metadata, runtime store, and loading/error state.
 *
 * @param schemaName - Name of the schema to load (null to skip)
 * @returns Schema preview state with schema, runtimeStore, loading, and error
 */
export function useSchemaPreview(schemaName: string | null): SchemaPreviewState {
  const metaStore = useWavesmithMetaStore()
  const [state, setState] = useState<SchemaPreviewState>({
    schema: null,
    runtimeStore: null,
    models: [],
    loading: false,
    error: null
  })

  useEffect(() => {
    if (!schemaName) {
      setState({ schema: null, runtimeStore: null, models: [], loading: false, error: null })
      return
    }

    let cancelled = false

    async function load() {
      setState(s => ({ ...s, loading: true, error: null }))

      try {
        console.log('[useSchemaPreview] Loading schema:', schemaName)

        // Load schema via meta-store (uses MCPPersistence under the hood)
        const loadedSchema = await metaStore.loadSchema(schemaName)

        // Cache models array immediately - avoids issues with MST computed views later
        // The computed view calls getRoot(self).modelCollection.all() which can fail
        // if the schema entity becomes detached or during re-renders
        const cachedModels = loadedSchema.models ? [...loadedSchema.models] : []
        console.log('[useSchemaPreview] Schema loaded:', loadedSchema.name, 'with', cachedModels.length, 'models')

        if (cancelled) return

        // Get runtime store from cache
        const store = getRuntimeStore(loadedSchema.id)
        if (!store) {
          throw new Error('Runtime store not found after schema load')
        }

        // Load data for all collections
        for (const model of cachedModels) {
          // Convert model name to collection name: "Page" → "pageCollection"
          const collectionName = `${model.name.charAt(0).toLowerCase()}${model.name.slice(1)}Collection`
          const collection = store[collectionName]

          if (collection?.query) {
            console.log('[useSchemaPreview] Loading collection:', collectionName)
            await collection.query().toArray()
          }
        }

        if (cancelled) return

        console.log('[useSchemaPreview] Schema preview ready')
        setState({
          schema: loadedSchema,
          runtimeStore: store,
          models: cachedModels,
          loading: false,
          error: null
        })

      } catch (err: any) {
        console.error('[useSchemaPreview] Error:', err)
        if (!cancelled) {
          setState(s => ({
            ...s,
            loading: false,
            error: err.message || 'Failed to load schema'
          }))
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [schemaName, metaStore])

  return state
}
