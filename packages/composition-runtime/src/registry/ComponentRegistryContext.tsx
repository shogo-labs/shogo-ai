/**
 * ComponentRegistryContext - React context for ComponentRegistry injection
 *
 * Follows WavesmithMetaStoreContext pattern from apps/web/src/contexts/
 *
 * Usage:
 * ```tsx
 * // Static registry (existing pattern)
 * const registry = createComponentRegistry({ defaultComponent, entries })
 *
 * <ComponentRegistryProvider registry={registry}>
 *   <MyApp />
 * </ComponentRegistryProvider>
 *
 * // Dynamic hydrated registry (new pattern - task-dcb-007)
 * <RegistryHydrationProvider
 *   registryId="default-registry"
 *   store={store}
 *   componentMap={implementationMap}
 * >
 *   <MyApp />
 * </RegistryHydrationProvider>
 *
 * function MyComponent() {
 *   const registry = useComponentRegistry()
 *   const Component = registry.resolve(propertyMetadata)
 *   return <Component property={metadata} value={value} />
 * }
 * ```
 *
 * Task: task-component-registry
 * Extended: task-dcb-007 (useHydratedRegistry, RegistryHydrationProvider)
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  type ReactNode,
  type ComponentType
} from "react"
import { reaction } from "mobx"
import {
  hydrateRegistry,
  type HydrationStore,
  type ComponentEntrySpec
} from "@shogo/state-api"

// Note: With componentBuilderDomain, Registry entities have:
// - toEntrySpecs(): ComponentEntrySpec[]  (returns hydrated specs)
// - fallbackRef: string | undefined       (resolved fallback implementationRef)
// The hydrateRegistry function is kept for backward compatibility but
// new code can use registry.toEntrySpecs() directly when using the domain.
import { ComponentRegistry, createComponentRegistry } from "./ComponentRegistry"
import type { DisplayRendererProps, ComponentEntry } from "../types"

// ============================================================================
// Context
// ============================================================================

/**
 * Context for ComponentRegistry
 */
const ComponentRegistryContext = createContext<ComponentRegistry | null>(null)

// ============================================================================
// Static Provider (existing)
// ============================================================================

export interface ComponentRegistryProviderProps {
  /** The registry instance to provide */
  registry: ComponentRegistry
  children: ReactNode
}

/**
 * Provider that makes ComponentRegistry available to descendants.
 *
 * The registry instance is passed directly (not created internally)
 * to allow configuration at the application level.
 */
export function ComponentRegistryProvider({
  registry,
  children
}: ComponentRegistryProviderProps) {
  return (
    <ComponentRegistryContext.Provider value={registry}>
      {children}
    </ComponentRegistryContext.Provider>
  )
}

/**
 * Hook to access the ComponentRegistry.
 *
 * @throws Error if used outside of ComponentRegistryProvider
 * @returns The ComponentRegistry instance
 */
export function useComponentRegistry(): ComponentRegistry {
  const context = useContext(ComponentRegistryContext)
  if (!context) {
    throw new Error(
      "useComponentRegistry must be used within ComponentRegistryProvider"
    )
  }
  return context
}

// ============================================================================
// Hydrated Registry Hook (task-dcb-007)
// ============================================================================

/**
 * Result of useHydratedRegistry hook
 */
export interface HydratedRegistryResult {
  /** The hydrated ComponentRegistry, or undefined if loading/error */
  registry: ComponentRegistry | undefined
  /** Whether the registry is being hydrated */
  loading: boolean
  /** Error message if registry hydration failed */
  error?: string
}

/**
 * Component implementation map type
 */
export type ComponentImplementationMap = Map<
  string,
  ComponentType<DisplayRendererProps>
>

/**
 * Convert ComponentEntrySpec to ComponentEntry by resolving componentRef
 * from the implementation map.
 *
 * @param spec - The ComponentEntrySpec from hydration
 * @param componentMap - Map of implementationRef to React components
 * @param fallback - Fallback component if ref not found in map
 * @returns ComponentEntry with React component
 */
function specToEntry(
  spec: ComponentEntrySpec,
  componentMap: ComponentImplementationMap,
  fallback: ComponentType<DisplayRendererProps>
): ComponentEntry {
  return {
    id: spec.id,
    priority: spec.priority,
    matches: spec.matcher,
    component: componentMap.get(spec.componentRef) ?? fallback,
    defaultConfig: spec.defaultConfig,
  }
}

/**
 * Hook that watches Registry entities and auto-rehydrates on changes.
 *
 * This hook:
 * 1. Calls hydrateRegistry() from state-api to get ComponentEntrySpec[]
 * 2. Maps specs to ComponentEntry[] using the provided componentMap
 * 3. Creates a ComponentRegistry with the hydrated entries
 * 4. Sets up MobX reactions to re-hydrate when entities change
 *
 * @param registryId - The ID of the Registry entity to hydrate
 * @param store - The store providing entity collections (HydrationStore interface)
 * @param componentMap - Map of implementationRef strings to React components
 * @returns HydratedRegistryResult with registry, loading, and error state
 *
 * @example
 * ```tsx
 * function MyApp() {
 *   const { registry, loading, error } = useHydratedRegistry(
 *     "default-registry",
 *     store,
 *     componentImplementationMap
 *   )
 *
 *   if (loading) return <LoadingSpinner />
 *   if (error) return <ErrorMessage error={error} />
 *   if (!registry) return null
 *
 *   return (
 *     <ComponentRegistryProvider registry={registry}>
 *       <Content />
 *     </ComponentRegistryProvider>
 *   )
 * }
 * ```
 *
 * @task task-dcb-007
 */
export function useHydratedRegistry(
  registryId: string,
  store: HydrationStore,
  componentMap: ComponentImplementationMap
): HydratedRegistryResult {
  // Track loading and error state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [registry, setRegistry] = useState<ComponentRegistry | undefined>(
    undefined
  )

  // Default fallback component (renders value as string)
  const FallbackDisplay = useMemo(() => {
    return ({ value }: DisplayRendererProps) => <span>{String(value ?? "")}</span>
  }, [])

  // Get fallback from componentMap or use default
  const fallbackComponent = useMemo(() => {
    return componentMap.get("FallbackDisplay") ?? FallbackDisplay
  }, [componentMap, FallbackDisplay])

  // Hydration function
  const hydrateAndSetRegistry = useMemo(() => {
    return () => {
      try {
        // Get the registry entity
        const registryEntity = store.Registries.get(registryId)

        if (!registryEntity) {
          setError(`Registry '${registryId}' not found`)
          setRegistry(undefined)
          setLoading(false)
          return
        }

        // Hydrate to get ComponentEntrySpec[]
        // Use entity methods when available (from componentBuilderDomain),
        // otherwise fall back to external hydrateRegistry function
        let specs: ComponentEntrySpec[]
        let fallbackRef: string | undefined

        if (typeof registryEntity.toEntrySpecs === "function") {
          // Domain pattern: entity has enhancement views
          specs = registryEntity.toEntrySpecs()
          fallbackRef = registryEntity.fallbackRef
        } else {
          // Fallback: use external hydration function
          const result = hydrateRegistry(registryEntity, store)
          specs = result.specs
          fallbackRef = result.fallbackRef
        }

        // Resolve fallback from the registry entity or use default
        const resolvedFallback = fallbackRef
          ? componentMap.get(fallbackRef) ?? fallbackComponent
          : fallbackComponent

        // Convert specs to entries
        const entries: ComponentEntry[] = specs.map((spec) =>
          specToEntry(spec, componentMap, resolvedFallback)
        )

        // Create the registry
        const newRegistry = createComponentRegistry({
          defaultComponent: resolvedFallback,
          entries
        })

        setRegistry(newRegistry)
        setError(undefined)
        setLoading(false)
      } catch (err: any) {
        setError(err.message ?? "Failed to hydrate registry")
        setRegistry(undefined)
        setLoading(false)
      }
    }
  }, [registryId, store, componentMap, fallbackComponent])

  // Initial hydration
  useEffect(() => {
    hydrateAndSetRegistry()
  }, [hydrateAndSetRegistry])

  // Set up MobX reaction to watch for entity changes
  useEffect(() => {
    const registryEntity = store.Registries.get(registryId)
    if (!registryEntity) return

    // Watch for changes to the registry's bindings array
    const disposeBindingsReaction = reaction(
      () => {
        // Access bindings array length and each binding's properties
        // to trigger reaction on any change
        const bindings = registryEntity.bindings || []
        return {
          length: bindings.length,
          // Access matchExpression of each binding to detect changes
          bindingStates: bindings.map((b: any) => ({
            id: b.id,
            matchExpression: JSON.stringify(b.matchExpression),
            priority: b.priority,
            componentRef: b.component?.implementationRef
          }))
        }
      },
      () => {
        // Re-hydrate when bindings change
        hydrateAndSetRegistry()
      },
      { fireImmediately: false }
    )

    // Watch for changes to the registry's fallback component
    const disposeFallbackReaction = reaction(
      () => registryEntity.fallbackComponent?.implementationRef,
      () => {
        // Re-hydrate when fallback changes
        hydrateAndSetRegistry()
      },
      { fireImmediately: false }
    )

    return () => {
      disposeBindingsReaction()
      disposeFallbackReaction()
    }
  }, [registryId, store, hydrateAndSetRegistry])

  return { registry, loading, error }
}

// ============================================================================
// Hydration Provider Component (task-dcb-007)
// ============================================================================

/**
 * Props for RegistryHydrationProvider
 */
export interface RegistryHydrationProviderProps {
  /** The ID of the Registry entity to hydrate */
  registryId: string
  /** The store providing entity collections */
  store: HydrationStore
  /** Map of implementationRef strings to React components */
  componentMap: ComponentImplementationMap
  /** Children to render once registry is hydrated */
  children: ReactNode
  /** Optional component to show while loading */
  loadingFallback?: ReactNode
  /** Optional component to show on error */
  errorFallback?: ComponentType<{ error: string }>
}

/**
 * Provider component that hydrates a registry from Wavesmith entities
 * and provides it to descendants via ComponentRegistryContext.
 *
 * Features:
 * - Automatically hydrates registry from Registry/RendererBinding entities
 * - MobX reactivity: re-hydrates when entities change
 * - Loading state while hydrating
 * - Error state if registry entity not found
 *
 * @example
 * ```tsx
 * <RegistryHydrationProvider
 *   registryId="default-registry"
 *   store={store}
 *   componentMap={componentImplementationMap}
 *   loadingFallback={<LoadingSpinner />}
 *   errorFallback={({ error }) => <ErrorAlert message={error} />}
 * >
 *   <MyApp />
 * </RegistryHydrationProvider>
 * ```
 *
 * @task task-dcb-007
 */
export function RegistryHydrationProvider({
  registryId,
  store,
  componentMap,
  children,
  loadingFallback,
  errorFallback: ErrorFallback
}: RegistryHydrationProviderProps) {
  const { registry, loading, error } = useHydratedRegistry(
    registryId,
    store,
    componentMap
  )

  // Show loading state
  if (loading) {
    return <>{loadingFallback ?? null}</>
  }

  // Show error state
  if (error) {
    if (ErrorFallback) {
      return <ErrorFallback error={error} />
    }
    // Default error rendering
    return (
      <div style={{ color: "red", padding: "1rem" }}>
        Registry hydration error: {error}
      </div>
    )
  }

  // No registry (shouldn't happen if no error, but be defensive)
  if (!registry) {
    return null
  }

  // Provide the hydrated registry to children
  return (
    <ComponentRegistryProvider registry={registry}>
      {children}
    </ComponentRegistryProvider>
  )
}
