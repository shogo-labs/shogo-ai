/**
 * DomainProvider - Map-based React provider for multiple domain stores
 *
 * Creates stores for multiple domains using environment from EnvironmentProvider.
 * Stores are keyed by the object keys you provide, enabling aliasing.
 *
 * OPTIMIZATION: Supports lazy loading via `eagerCollections` config.
 * Only specified collections are loaded on mount; others load on-demand.
 *
 * Usage:
 * ```tsx
 * import { DomainProvider, useDomains } from './contexts/DomainProvider'
 * import { teamsDomain, authDomain } from '@shogo/state-api'
 *
 * // In App.tsx - define domains as map
 * const domains = {
 *   teams: teamsDomain,
 *   auth: authDomain,
 * } as const
 *
 * // Optional: specify which collections to load eagerly
 * const eagerCollections = {
 *   teams: ['organizationCollection'],
 *   auth: ['userCollection'],
 * }
 *
 * <EnvironmentProvider env={env}>
 *   <DomainProvider domains={domains} eagerCollections={eagerCollections}>
 *     <Routes>...</Routes>
 *   </DomainProvider>
 * </EnvironmentProvider>
 *
 * // In components - destructure what you need
 * function MyComponent() {
 *   const { teams, auth } = useDomains()
 *   return <div>{teams.organizationCollection.all().length} orgs</div>
 * }
 * ```
 */

import { createContext, useContext, useRef, useEffect, useMemo, useState, type ReactNode } from "react"
import type { DomainResult } from "@shogo/state-api"
import { getMetaStore } from "@shogo/state-api"
import { useEnv } from "./EnvironmentContext"
import { useSession } from "../auth/client"

// ============================================================================
// Types
// ============================================================================

/** Map of string keys to DomainResult objects */
export type DomainsMap = Record<string, DomainResult>

/**
 * Configuration for which collections to load eagerly on mount.
 * Key is the domain key (from domains prop), value is array of collection names.
 * Collections not listed here will NOT be loaded on mount (lazy loading).
 * If a domain key is not present, ALL its collections will be loaded (backwards compat).
 * If a domain key maps to empty array [], NO collections will be loaded for that domain.
 */
export type EagerCollectionsConfig = Record<string, string[]>

/** Context value holds stores keyed the same as input domains */
interface DomainProviderContextValue {
  stores: Record<string, any>
  /** Maps schema name (e.g., "platform-features") to user-provided key (e.g., "platformFeatures") */
  schemaNameToKey: Record<string, string>
  /** True while schemas are being loaded from MCP */
  schemasLoading: boolean
  /** True once all schemas have been loaded (or failed) */
  schemasLoaded: boolean
}

// ============================================================================
// Context
// ============================================================================

const DomainProviderContext = createContext<DomainProviderContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface DomainProviderProps<T extends DomainsMap> {
  /** Map of key → DomainResult. Keys become the property names in useDomains() */
  domains: T
  children: ReactNode
  /**
   * OPTIMIZATION: Specify which collections to load eagerly on mount.
   * Format: { domainKey: ['collectionName1', 'collectionName2'] }
   *
   * - If not provided: ALL collections from ALL domains load (original behavior)
   * - If domain key present with array: only those collections load
   * - If domain key present with empty array: NO collections load for that domain
   * - If domain key absent: ALL collections load for that domain (backwards compat)
   */
  eagerCollections?: EagerCollectionsConfig
}

/**
 * Provider that creates MST stores for each domain in the map.
 *
 * Features:
 * - Map-based: Keys you provide become property names for access
 * - Uses EnvironmentProvider: Gets persistence/context from ancestor
 * - Stable stores: Uses useRef to ensure stores aren't recreated
 * - Auto-loading: Loads persisted data on mount via useEffect
 *
 * @example
 * ```tsx
 * <DomainProvider domains={{ teams: teamsDomain, projects: projectsDomain }}>
 *   <App />
 * </DomainProvider>
 * ```
 */
export function DomainProvider<T extends DomainsMap>({
  domains,
  children,
  eagerCollections,
}: DomainProviderProps<T>) {
  const env = useEnv() // Get environment from EnvironmentProvider (throws if missing)
  const session = useSession() // Get current auth session for authorization context
  const storesRef = useRef<Record<string, any> | null>(null)
  const schemaNameToKeyRef = useRef<Record<string, string> | null>(null)

  // Schema loading state - used by SchemaLoadingGate to block rendering until ready
  const [schemasLoading, setSchemasLoading] = useState(true)
  const [schemasLoaded, setSchemasLoaded] = useState(false)

  // Get current user ID for authorization context
  // This will be injected into each store's environment for query-level filtering
  const currentUserId = session.data?.user?.id

  // Initialize all domain stores once (stable across re-renders)
  // Note: When user changes, App.tsx remounts DomainProvider via key={authKey},
  // so stores are recreated with the new user's authContext
  if (!storesRef.current) {
    const stores: Record<string, any> = {}
    const schemaNameToKey: Record<string, string> = {}

    for (const [key, domain] of Object.entries(domains)) {
      // Build store-specific environment with domain's schemaName and auth context
      const storeEnv = {
        ...env,
        context: {
          ...env.context,
          schemaName: domain.name, // Use domain.name for persistence context
          // Inject auth context for authorization-based query filtering
          ...(currentUserId && {
            authContext: { userId: currentUserId }
          }),
        },
      }

      // Create store and key by the user-provided key (not domain.name)
      stores[key] = domain.createStore(storeEnv)

      // Build reverse lookup: schema name → user-provided key
      schemaNameToKey[domain.name] = key
    }

    storesRef.current = stores
    schemaNameToKeyRef.current = schemaNameToKey
  }

  // Load schemas and persisted data on mount
  useEffect(() => {
    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 500

    /**
     * Load a single schema with retry logic.
     * Returns true if loaded successfully, false otherwise.
     * Also ingests the schema into the browser's metaStore singleton
     * so CollectionAuthorizable can access x-authorization metadata.
     */
    const loadSchemaWithRetry = async (
      persistence: any,
      key: string,
      schemaName: string,
      location: string | undefined,
      attempt = 1
    ): Promise<boolean> => {
      try {
        const result = await persistence.loadSchema(schemaName, location)

        // Ingest schema into browser's metaStore singleton
        // This enables CollectionAuthorizable to find model.xAuthorization
        if (result?.enhanced) {
          try {
            const browserMetaStore = getMetaStore()
            browserMetaStore.ingestEnhancedJsonSchema(result.enhanced, {
              name: result.metadata?.name || schemaName,
              id: result.metadata?.id,
              createdAt: Date.now(),
            })
            console.debug(`[DomainProvider] Ingested schema "${schemaName}" into browser metaStore`)
          } catch (ingestErr) {
            console.warn(`[DomainProvider] Failed to ingest schema "${schemaName}" into browser metaStore:`, ingestErr)
          }
        }

        return true
      } catch (err: any) {
        // Don't retry on SCHEMA_NOT_FOUND - the schema genuinely doesn't exist
        if (err?.code === 'SCHEMA_NOT_FOUND' || err?.message?.includes('not found')) {
          console.debug(`[DomainProvider] Schema "${key}" not found - may need to be created`)
          return false
        }

        if (attempt < MAX_RETRIES) {
          console.debug(`[DomainProvider] Retrying schema load for "${key}" (${attempt}/${MAX_RETRIES})...`)
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
          return loadSchemaWithRetry(persistence, key, schemaName, location, attempt + 1)
        }

        console.error(`[DomainProvider] Failed to load schema for "${key}" after ${MAX_RETRIES} attempts:`, err)
        return false
      }
    }

    const loadAllDomainData = async () => {
      const stores = storesRef.current
      if (!stores) return

      // First, ensure schemas are loaded into the MCP server's meta-store
      // This is required before store.create/update operations will work
      // OPTIMIZATION: Load all schemas in a single batched HTTP request
      const persistence = env.services?.persistence as any
      if (persistence?.loadSchemasBatch) {
        // Use batch loading - single HTTP request for all schemas
        const schemaRequests = Object.entries(domains).map(([_, domain]) => ({
          name: domain.name,
          location: env.context?.location,
        }))
        try {
          const batchResults = await persistence.loadSchemasBatch(schemaRequests)

          // Ingest each schema into browser's metaStore singleton
          // This enables CollectionAuthorizable to find model.xAuthorization
          const browserMetaStore = getMetaStore()
          for (const [schemaName, result] of batchResults.entries()) {
            if (result?.enhanced) {
              try {
                browserMetaStore.ingestEnhancedJsonSchema(result.enhanced, {
                  name: result.metadata?.name || schemaName,
                  id: result.metadata?.id,
                  createdAt: Date.now(),
                })
                console.debug(`[DomainProvider] Ingested schema "${schemaName}" into browser metaStore`)
              } catch (ingestErr) {
                console.warn(`[DomainProvider] Failed to ingest schema "${schemaName}" into browser metaStore:`, ingestErr)
              }
            }
          }
        } catch (err) {
          console.error(`[DomainProvider] Batch schema load failed, falling back to individual loads:`, err)
          // Fallback to individual loads with retry logic
          const schemaLoadPromises = Object.entries(domains).map(
            ([key, domain]) => loadSchemaWithRetry(
              persistence,
              key,
              domain.name,
              env.context?.location
            )
          )
          await Promise.all(schemaLoadPromises)
        }
      } else if (persistence?.loadSchema) {
        // Fallback: load schemas in parallel with retry logic
        const schemaLoadPromises = Object.entries(domains).map(
          ([key, domain]) => loadSchemaWithRetry(
            persistence,
            key,
            domain.name,
            env.context?.location
          )
        )
        await Promise.all(schemaLoadPromises)
      }

      // Then load persisted data for each store using query() API
      // This uses the backend registry (PostgreSQL) and auto-syncs to MST
      // OPTIMIZATION: Only load collections specified in eagerCollections config
      // If no config provided, load ALL collections (backwards compatibility)
      const collectionLoadPromises: Promise<void>[] = []

      for (const [key, store] of Object.entries(stores)) {
        // Find all collections (properties ending with "Collection")
        const allCollectionNames = Object.keys(store).filter((prop) =>
          prop.endsWith("Collection")
        )

        // Determine which collections to load for this domain
        let collectionsToLoad: string[]
        if (eagerCollections === undefined) {
          // No config provided - load ALL collections (backwards compatibility)
          collectionsToLoad = allCollectionNames
        } else if (eagerCollections[key] !== undefined) {
          // Config specifies which collections to load for this domain
          // Filter to only collections that exist in the store
          collectionsToLoad = eagerCollections[key].filter(name =>
            allCollectionNames.includes(name)
          )
        } else {
          // Domain not in config - load ALL its collections (backwards compatibility)
          collectionsToLoad = allCollectionNames
        }

        for (const collectionName of collectionsToLoad) {
          const collection = store[collectionName]
          // Use query().toArray() which routes through backendRegistry
          // Remote executors auto-sync results to MST via syncFromRemote callback
          if (collection?.query && typeof collection.query === "function") {
            collectionLoadPromises.push(
              collection.query().toArray().catch((err: unknown) => {
                console.error(
                  `[DomainProvider] Failed to load "${collectionName}" for "${key}":`,
                  err
                )
              })
            )
          }
        }
      }

      await Promise.all(collectionLoadPromises)
    }

    loadAllDomainData()
      .then(() => {
        setSchemasLoaded(true)
        setSchemasLoading(false)
      })
      .catch((err) => {
        console.error('[DomainProvider] Schema loading failed:', err)
        setSchemasLoading(false)
        // Set loaded to true even on error so components can try to render
        // They'll see errors but the app won't be stuck in loading state
        setSchemasLoaded(true)
      })
  }, []) // Run once on mount

  // Memoize context value, updating when loading state changes.
  // storesRef.current is set once during initialization and never changes,
  // but schemasLoading/schemasLoaded update when async loading completes.
  const contextValue = useMemo<DomainProviderContextValue>(
    () => ({
      stores: storesRef.current!,
      schemaNameToKey: schemaNameToKeyRef.current!,
      schemasLoading,
      schemasLoaded,
    }),
    [schemasLoading, schemasLoaded]
  )

  return (
    <DomainProviderContext.Provider value={contextValue}>
      {children}
    </DomainProviderContext.Provider>
  )
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access all domain stores as a destructurable object.
 *
 * @throws Error if used outside DomainProvider
 * @returns Object with stores keyed by the names provided to DomainProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { teams, auth } = useDomains()
 *   const orgs = teams.organizationCollection.all()
 *   const user = auth.currentUser
 * }
 * ```
 */
export function useDomains<T extends DomainsMap = DomainsMap>(): {
  [K in keyof T]: any
} {
  const ctx = useContext(DomainProviderContext)
  if (!ctx) {
    throw new Error("useDomains must be used within DomainProvider")
  }
  return ctx.stores as { [K in keyof T]: any }
}

/**
 * Hook to access a domain store by schema name.
 *
 * This enables components to look up stores by schema name (e.g., "platform-features")
 * without knowing the internal key used in DomainProvider (e.g., "platformFeatures").
 *
 * @param schemaName - The schema name (e.g., "platform-features", "studio-chat")
 * @returns The domain store, or undefined if not found
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const platformFeatures = useDomainStore("platform-features")
 *   const requirements = platformFeatures?.requirementCollection?.all() ?? []
 * }
 * ```
 */
export function useDomainStore(schemaName: string): any {
  const ctx = useContext(DomainProviderContext)
  if (!ctx) {
    throw new Error("useDomainStore must be used within DomainProvider")
  }

  const key = ctx.schemaNameToKey[schemaName]
  if (!key) {
    // Not an error - schema might not be registered
    return undefined
  }

  return ctx.stores[key]
}

/**
 * Hook to check if domain schemas have finished loading.
 *
 * Use this to gate component rendering until schemas are ready,
 * preventing "Schema not found" errors from race conditions.
 *
 * @returns Object with schemasLoading and schemasLoaded booleans
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { schemasLoaded } = useSchemaLoadingState()
 *   if (!schemasLoaded) return <LoadingSpinner />
 *   // Safe to access collections now
 *   const { studioCore } = useDomains()
 *   return <div>{studioCore.workspaceCollection.all().length} workspaces</div>
 * }
 * ```
 */
export function useSchemaLoadingState(): { schemasLoading: boolean; schemasLoaded: boolean } {
  const ctx = useContext(DomainProviderContext)
  if (!ctx) {
    throw new Error("useSchemaLoadingState must be used within DomainProvider")
  }
  return {
    schemasLoading: ctx.schemasLoading,
    schemasLoaded: ctx.schemasLoaded,
  }
}
