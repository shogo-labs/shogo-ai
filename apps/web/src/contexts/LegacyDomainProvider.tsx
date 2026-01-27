/**
 * LegacyDomainProvider - Original state-api based provider
 *
 * This provider uses @shogo/state-api domains with domain-specific query methods
 * like findByMembership, findByWorkspace, findByUser.
 *
 * It will be deprecated once all components migrate to SDK-generated collections.
 *
 * Migration guide:
 * - Replace domain-specific queries with SDK collection methods
 * - Use filter/find predicates instead of findByX methods
 * - Import from SDKDomainProvider instead
 */

import { createContext, useContext, useRef, useEffect, useMemo, useState, type ReactNode } from "react"
import type { DomainResult } from "@shogo/state-api"
import { useEnv } from "./EnvironmentContext"
import { useSession } from "./SessionProvider"

// ============================================================================
// Types
// ============================================================================

/** Map of string keys to DomainResult objects */
export type DomainsMap = Record<string, DomainResult>

/**
 * Configuration for which collections to load eagerly on mount.
 */
export type EagerCollectionsConfig = Record<string, string[]>

/** Context value holds stores keyed the same as input domains */
interface LegacyDomainContextValue {
  stores: Record<string, any>
  schemaNameToKey: Record<string, string>
  schemasLoading: boolean
  schemasLoaded: boolean
}

// ============================================================================
// Context
// ============================================================================

const LegacyDomainContext = createContext<LegacyDomainContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface LegacyDomainProviderProps<T extends DomainsMap> {
  domains: T
  children: ReactNode
  eagerCollections?: EagerCollectionsConfig
}

/**
 * Legacy provider that creates MST stores for each domain in the map.
 * Uses state-api domains with domain-specific query methods.
 */
export function LegacyDomainProvider<T extends DomainsMap>({
  domains,
  children,
  eagerCollections,
}: LegacyDomainProviderProps<T>) {
  const env = useEnv()
  const session = useSession()
  const storesRef = useRef<Record<string, any> | null>(null)
  const schemaNameToKeyRef = useRef<Record<string, string> | null>(null)

  const [schemasLoading, setSchemasLoading] = useState(true)
  const [schemasLoaded, setSchemasLoaded] = useState(false)

  const currentUserId = session.data?.user?.id

  // Initialize all domain stores once
  if (!storesRef.current) {
    const stores: Record<string, any> = {}
    const schemaNameToKey: Record<string, string> = {}

    for (const [key, domain] of Object.entries(domains)) {
      const storeEnv = {
        ...env,
        context: {
          ...env.context,
          schemaName: domain.name,
          ...(currentUserId && {
            authContext: { userId: currentUserId }
          }),
        },
      }

      stores[key] = domain.createStore(storeEnv)
      schemaNameToKey[domain.name] = key
    }

    storesRef.current = stores
    schemaNameToKeyRef.current = schemaNameToKey
  }

  useEffect(() => {
    setSchemasLoaded(true)
    setSchemasLoading(false)
  }, [])

  const contextValue = useMemo<LegacyDomainContextValue>(
    () => ({
      stores: storesRef.current!,
      schemaNameToKey: schemaNameToKeyRef.current!,
      schemasLoading,
      schemasLoaded,
    }),
    [schemasLoading, schemasLoaded]
  )

  return (
    <LegacyDomainContext.Provider value={contextValue}>
      {children}
    </LegacyDomainContext.Provider>
  )
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access all domain stores (legacy state-api domains).
 */
export function useDomains<T extends DomainsMap = DomainsMap>(): {
  [K in keyof T]: any
} {
  const ctx = useContext(LegacyDomainContext)
  if (!ctx) {
    throw new Error("useDomains must be used within LegacyDomainProvider")
  }
  return ctx.stores as { [K in keyof T]: any }
}

/**
 * Hook to access a domain store by schema name.
 */
export function useDomainStore(schemaName: string): any {
  const ctx = useContext(LegacyDomainContext)
  if (!ctx) {
    throw new Error("useDomainStore must be used within LegacyDomainProvider")
  }

  const key = ctx.schemaNameToKey[schemaName]
  if (!key) return undefined

  return ctx.stores[key]
}

/**
 * Hook to check if domain schemas have finished loading.
 */
export function useSchemaLoadingState(): { schemasLoading: boolean; schemasLoaded: boolean } {
  const ctx = useContext(LegacyDomainContext)
  if (!ctx) {
    throw new Error("useSchemaLoadingState must be used within LegacyDomainProvider")
  }
  return {
    schemasLoading: ctx.schemasLoading,
    schemasLoaded: ctx.schemasLoaded,
  }
}
