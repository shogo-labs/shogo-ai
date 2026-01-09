/**
 * DomainProvider - Map-based React provider for multiple domain stores
 *
 * Creates stores for multiple domains using environment from EnvironmentProvider.
 * Stores are keyed by the object keys you provide, enabling aliasing.
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
 * <EnvironmentProvider env={env}>
 *   <DomainProvider domains={domains}>
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

import { createContext, useContext, useRef, useEffect, useMemo, type ReactNode } from "react"
import type { DomainResult } from "@shogo/state-api"
import { useEnv } from "./EnvironmentContext"

// ============================================================================
// Types
// ============================================================================

/** Map of string keys to DomainResult objects */
export type DomainsMap = Record<string, DomainResult>

/** Context value holds stores keyed the same as input domains */
interface DomainProviderContextValue {
  stores: Record<string, any>
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
}: DomainProviderProps<T>) {
  const env = useEnv() // Get environment from EnvironmentProvider (throws if missing)
  const storesRef = useRef<Record<string, any> | null>(null)

  // Initialize all domain stores once (stable across re-renders)
  if (!storesRef.current) {
    const stores: Record<string, any> = {}

    for (const [key, domain] of Object.entries(domains)) {
      // Build store-specific environment with domain's schemaName
      const storeEnv = {
        ...env,
        context: {
          ...env.context,
          schemaName: domain.name, // Use domain.name for persistence context
        },
      }

      // Create store and key by the user-provided key (not domain.name)
      stores[key] = domain.createStore(storeEnv)
    }

    storesRef.current = stores
  }

  // Load schemas and persisted data on mount
  useEffect(() => {
    const loadAllDomainData = async () => {
      const stores = storesRef.current
      if (!stores) return

      // First, ensure schemas are loaded into the MCP server's meta-store
      // This is required before store.create/update operations will work
      const persistence = env.services?.persistence as any
      if (persistence?.loadSchema) {
        for (const [key, domain] of Object.entries(domains)) {
          try {
            await persistence.loadSchema(domain.name, env.context?.location)
          } catch (err) {
            console.error(`[DomainProvider] Failed to load schema for "${key}":`, err)
          }
        }
      }

      // Then load persisted data for each store using query() API
      // This uses the backend registry (PostgreSQL) and auto-syncs to MST
      for (const [key, store] of Object.entries(stores)) {
        try {
          // Find all collections (properties ending with "Collection")
          const collectionNames = Object.keys(store).filter((prop) =>
            prop.endsWith("Collection")
          )

          for (const collectionName of collectionNames) {
            const collection = store[collectionName]
            // Use query().toArray() which routes through backendRegistry
            // Remote executors auto-sync results to MST via syncFromRemote callback
            if (collection?.query && typeof collection.query === "function") {
              await collection.query().toArray()
            }
          }
        } catch (err) {
          console.error(`[DomainProvider] Failed to load data for "${key}":`, err)
        }
      }
    }

    loadAllDomainData()
  }, []) // Run once on mount

  // PERF FIX: Memoize context value to prevent unnecessary consumer re-renders.
  // storesRef.current is set once during initialization and never changes,
  // so we can safely memoize with empty deps.
  const contextValue = useMemo<DomainProviderContextValue>(
    () => ({ stores: storesRef.current! }),
    []
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
