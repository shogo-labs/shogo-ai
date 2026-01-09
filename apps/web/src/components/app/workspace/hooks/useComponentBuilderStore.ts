/**
 * useComponentBuilderStore Hook
 * Task: task-dcb-008
 *
 * Provides typed access to the component-builder schema store.
 * Handles schema loading and returns collection accessors for:
 * - ComponentDefinition entities
 * - Registry entities
 * - RendererBinding entities
 *
 * Uses the WavesmithMetaStoreContext pattern for schema loading
 * and collection access with MobX reactivity.
 *
 * @example
 * ```tsx
 * function ComponentCatalog() {
 *   const { loading, error, store } = useComponentBuilderStore()
 *
 *   if (loading) return <Spinner />
 *   if (error) return <ErrorDisplay error={error} />
 *   if (!store) return null
 *
 *   const components = store.componentDefinitions.all()
 *   return <ComponentList components={components} />
 * }
 * ```
 */

import { useState, useEffect, useMemo } from "react"
import { useOptionalWavesmithMetaStore } from "../../../../contexts/WavesmithMetaStoreContext"
import { getRuntimeStore } from "@shogo/state-api"

// ============================================================
// Type Definitions
// ============================================================

/**
 * Entity type for ComponentDefinition from the component-builder schema.
 * Represents a reusable UI component definition with metadata.
 */
export interface ComponentDefinitionEntity {
  id: string
  name: string
  category: "display" | "input" | "layout" | "visualization"
  description?: string
  propsSchema?: object
  implementationRef: string
  previewRef?: string
  tags?: string[]
  createdAt: number
  updatedAt?: number
}

/**
 * Entity type for Registry from the component-builder schema.
 * Maps PropertyMetadata to ComponentDefinitions via bindings.
 */
export interface RegistryEntity {
  id: string
  name: string
  description?: string
  extends?: RegistryEntity
  fallbackComponent?: ComponentDefinitionEntity
  bindings?: BindingEntity[]
  createdAt: number
  updatedAt?: number
}

/**
 * Entity type for RendererBinding from the component-builder schema.
 * Binds a ComponentDefinition to a Registry via a MongoDB-style match expression.
 */
export interface BindingEntity {
  id: string
  name: string
  registry: RegistryEntity | string
  component: ComponentDefinitionEntity | string
  matchExpression: object
  priority: number
  createdAt: number
  updatedAt?: number
}

/**
 * Collection accessor interface for typed entity access.
 */
export interface CollectionAccessor<T> {
  /** Returns all entities in the collection */
  all(): T[]
  /** Gets an entity by ID, or undefined if not found */
  get(id: string): T | undefined
}

/**
 * Extended collection accessor for RendererBinding with filtering support.
 */
export interface BindingCollectionAccessor extends CollectionAccessor<BindingEntity> {
  /** Returns all bindings for a specific registry ID */
  forRegistry(registryId: string): BindingEntity[]
}

/**
 * Store shape returned by the hook when loaded.
 */
export interface ComponentBuilderStore {
  /** Collection accessor for ComponentDefinition entities */
  componentDefinitions: CollectionAccessor<ComponentDefinitionEntity>
  /** Collection accessor for Registry entities */
  registries: CollectionAccessor<RegistryEntity>
  /** Collection accessor for RendererBinding entities with registry filtering */
  rendererBindings: BindingCollectionAccessor
}

/**
 * Result type returned by useComponentBuilderStore hook.
 */
export interface ComponentBuilderStoreResult {
  /** True while the schema is loading */
  loading: boolean
  /** Error if schema loading failed, null otherwise */
  error: Error | null
  /** The store with collection accessors, null while loading or on error */
  store: ComponentBuilderStore | null
}

// ============================================================
// Schema Name Constant
// ============================================================

/** Name of the component-builder schema to load */
const COMPONENT_BUILDER_SCHEMA_NAME = "component-builder"

// ============================================================
// Collection Accessor Factory
// ============================================================

/**
 * Creates a collection accessor from an MST collection.
 *
 * @param collection - MST collection with .all() method
 * @returns Collection accessor with all() and get() methods
 */
function createCollectionAccessor<T>(collection: any): CollectionAccessor<T> {
  return {
    all(): T[] {
      return collection?.all?.() ?? []
    },
    get(id: string): T | undefined {
      // MST collections typically use .get() on the model map
      // or we can filter from all()
      const all = collection?.all?.() ?? []
      return all.find((item: any) => item.id === id) as T | undefined
    },
  }
}

/**
 * Creates a binding collection accessor with forRegistry support.
 *
 * @param collection - MST collection for RendererBinding
 * @returns Binding collection accessor with all(), get(), and forRegistry() methods
 */
function createBindingCollectionAccessor(collection: any): BindingCollectionAccessor {
  const baseAccessor = createCollectionAccessor<BindingEntity>(collection)

  return {
    ...baseAccessor,
    forRegistry(registryId: string): BindingEntity[] {
      const all = baseAccessor.all()
      return all.filter((binding: BindingEntity) => {
        // Registry can be a reference (object) or string ID
        const regId = typeof binding.registry === "string"
          ? binding.registry
          : binding.registry?.id
        return regId === registryId
      })
    },
  }
}

// ============================================================
// Hook Implementation
// ============================================================

/**
 * Hook that provides typed access to the component-builder schema store.
 *
 * Handles async schema loading via WavesmithMetaStoreContext and returns
 * collection accessors for ComponentDefinition, Registry, and RendererBinding
 * entities.
 *
 * Note: If used outside of WavesmithMetaStoreProvider, returns a "not available"
 * state with loading=false, error=null, store=null. This allows the hook to be
 * used in components that may or may not have the meta-store context.
 *
 * @returns ComponentBuilderStoreResult with loading, error, and store
 *
 * @example
 * ```tsx
 * const { loading, error, store } = useComponentBuilderStore()
 *
 * // Access all component definitions
 * const components = store?.componentDefinitions.all() ?? []
 *
 * // Get a specific component by ID
 * const component = store?.componentDefinitions.get("comp-123")
 *
 * // Get all bindings for a registry
 * const bindings = store?.rendererBindings.forRegistry("default-registry")
 * ```
 */
export function useComponentBuilderStore(): ComponentBuilderStoreResult {
  const metaStore = useOptionalWavesmithMetaStore()

  const [state, setState] = useState<{
    loading: boolean
    error: Error | null
    schema: any | null
    runtimeStore: any | null
  }>({
    loading: !!metaStore, // Only loading if metaStore is available
    error: null,
    schema: null,
    runtimeStore: null,
  })

  useEffect(() => {
    // If no meta-store context, don't try to load
    if (!metaStore) {
      setState({
        loading: false,
        error: null,
        schema: null,
        runtimeStore: null,
      })
      return
    }

    let cancelled = false

    async function loadComponentBuilderSchema() {
      setState(s => ({ ...s, loading: true, error: null }))

      try {
        console.log("[useComponentBuilderStore] Loading schema:", COMPONENT_BUILDER_SCHEMA_NAME)

        // Load schema via meta-store (uses persistence under the hood)
        const loadedSchema = await metaStore.loadSchema(COMPONENT_BUILDER_SCHEMA_NAME)

        if (cancelled) return

        // Get runtime store from cache
        const store = getRuntimeStore(loadedSchema.id)
        if (!store) {
          throw new Error("Runtime store not found after schema load")
        }

        // Load data for all collections
        const models = loadedSchema.models ? [...loadedSchema.models] : []
        for (const model of models) {
          const collectionName = `${model.name.charAt(0).toLowerCase()}${model.name.slice(1)}Collection`
          const collection = store[collectionName]

          if (collection?.loadAll) {
            console.log("[useComponentBuilderStore] Loading collection:", collectionName)
            await collection.loadAll()
          }
        }

        if (cancelled) return

        console.log("[useComponentBuilderStore] Schema and collections loaded successfully")
        setState({
          loading: false,
          error: null,
          schema: loadedSchema,
          runtimeStore: store,
        })
      } catch (err: any) {
        console.error("[useComponentBuilderStore] Error loading schema:", err)
        if (!cancelled) {
          setState({
            loading: false,
            error: err instanceof Error ? err : new Error(err.message || "Failed to load component-builder schema"),
            schema: null,
            runtimeStore: null,
          })
        }
      }
    }

    loadComponentBuilderSchema()

    return () => {
      cancelled = true
    }
  }, [metaStore])

  // Build the store interface with collection accessors
  const store = useMemo<ComponentBuilderStore | null>(() => {
    if (!state.runtimeStore) return null

    // Access collections from runtime store
    // Collection names follow pattern: "EntityName" -> "entityNameCollection"
    const componentDefinitionCollection = state.runtimeStore.componentDefinitionCollection
    const registryCollection = state.runtimeStore.registryCollection
    const rendererBindingCollection = state.runtimeStore.rendererBindingCollection

    return {
      componentDefinitions: createCollectionAccessor<ComponentDefinitionEntity>(componentDefinitionCollection),
      registries: createCollectionAccessor<RegistryEntity>(registryCollection),
      rendererBindings: createBindingCollectionAccessor(rendererBindingCollection),
    }
  }, [state.runtimeStore])

  return {
    loading: state.loading,
    error: state.error,
    store,
  }
}
