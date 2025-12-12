/**
 * ApplicationDomains - Compound React provider for multiple domain stores
 *
 * Creates stores for multiple domains with shared persistence and optional
 * auto-registration with meta-store when WavesmithMetaStoreProvider is ancestor.
 *
 * Usage:
 * ```tsx
 * import { ApplicationDomains, useDomain } from './contexts/ApplicationDomains'
 * import { teamsDomain, authDomain } from '@shogo/state-api'
 *
 * // In App.tsx
 * <ApplicationDomains
 *   domains={[teamsDomain]}
 *   persistence={persistence}
 * >
 *   <Routes>...</Routes>
 * </ApplicationDomains>
 *
 * // In components
 * function MyComponent() {
 *   const teams = useDomain(teamsDomain)
 *   return <div>{teams.organizationCollection.all().length} orgs</div>
 * }
 * ```
 */

import { createContext, useContext, useRef, useEffect, type ReactNode } from "react"
import type { DomainResult, IPersistenceService } from "@shogo/state-api"
import { useWavesmithMetaStore } from "./WavesmithMetaStoreContext"
import { mcpService } from "../services/mcpService"

interface ApplicationDomainsContextValue {
  stores: Map<string, any>
  persistence: IPersistenceService
}

const ApplicationDomainsContext = createContext<ApplicationDomainsContextValue | null>(null)

export interface ApplicationDomainsProps {
  /** Array of domain results from domain() calls */
  domains: DomainResult[]
  /** Shared persistence service for all domains */
  persistence: IPersistenceService
  /** Whether to auto-register with meta-store if available (default: true) */
  autoRegister?: boolean
  children: ReactNode
}

/**
 * Compound provider that creates stores for multiple domains.
 *
 * Features:
 * - Creates stable store instances (useRef)
 * - Shares single persistence instance across all domains
 * - Auto-registers with meta-store when WavesmithMetaStoreProvider is ancestor
 * - Initializes all collections on mount
 */
export function ApplicationDomains({
  domains,
  persistence,
  autoRegister = true,
  children,
}: ApplicationDomainsProps) {
  const contextRef = useRef<ApplicationDomainsContextValue | null>(null)

  // Try to get meta-store from ancestor (optional)
  const metaStore = useOptionalMetaStore()

  // Initialize all domain stores once
  if (!contextRef.current) {
    const stores = new Map<string, any>()

    for (const domain of domains) {
      // Auto-register with meta-store when available
      if (autoRegister && metaStore) {
        try {
          domain.register(metaStore)
        } catch (err) {
          console.warn(`[ApplicationDomains] Failed to register ${domain.name} with meta-store:`, err)
        }
      }

      // Create store with shared persistence
      const env = {
        services: { persistence },
        context: { schemaName: domain.name },
      }
      const store = domain.createStore(env)
      stores.set(domain.name, store)
    }

    contextRef.current = { stores, persistence }
    console.log(`[ApplicationDomains] Created stores for ${domains.map(d => d.name).join(", ")}`)
  }

  // Load persisted data on mount
  useEffect(() => {
    const loadAllDomainData = async () => {
      const { stores } = contextRef.current!

      try {
        // Initialize MCP session before any tool calls (required for HTTP transport)
        await mcpService.initializeSession()

        // Load schemas on MCP server for each domain
        for (const domain of domains) {
          await mcpService.loadSchema(domain.name)
        }
      } catch (err) {
        console.error("[ApplicationDomains] Failed to initialize MCP session:", err)
        return
      }

      for (const [name, store] of stores) {
        try {
          // Load all collections for this store
          // Collections are named {entityName}Collection
          const collectionNames = Object.keys(store).filter(key => key.endsWith("Collection"))

          for (const collectionName of collectionNames) {
            const collection = store[collectionName]
            if (collection?.loadAll && typeof collection.loadAll === "function") {
              await collection.loadAll()
            }
          }
        } catch (err) {
          console.error(`[ApplicationDomains] Failed to load data for ${name}:`, err)
        }
      }
    }

    loadAllDomainData()
  }, [domains])

  return (
    <ApplicationDomainsContext.Provider value={contextRef.current}>
      {children}
    </ApplicationDomainsContext.Provider>
  )
}

/**
 * Type-safe hook to access a domain store.
 *
 * The domain parameter provides the type inference.
 *
 * @param domain - The DomainResult from domain() call
 * @returns The store instance for that domain
 * @throws Error if domain not found or used outside ApplicationDomains
 *
 * @example
 * ```tsx
 * const teams = useDomain(teamsDomain)
 * const orgs = teams.organizationCollection.all()
 * ```
 */
export function useDomain<T = any>(domain: DomainResult): T {
  const ctx = useContext(ApplicationDomainsContext)
  if (!ctx) {
    throw new Error("useDomain must be used within ApplicationDomains")
  }

  const store = ctx.stores.get(domain.name)
  if (!store) {
    throw new Error(
      `Domain '${domain.name}' not found in ApplicationDomains. ` +
      `Did you include it in the domains array?`
    )
  }

  return store as T
}

/**
 * Hook to get shared persistence service.
 *
 * @returns The persistence service shared across all domains
 */
export function useApplicationPersistence(): IPersistenceService {
  const ctx = useContext(ApplicationDomainsContext)
  if (!ctx) {
    throw new Error("useApplicationPersistence must be used within ApplicationDomains")
  }
  return ctx.persistence
}

/**
 * Helper to optionally get meta-store (doesn't throw if missing).
 * This allows ApplicationDomains to work with or without WavesmithMetaStoreProvider.
 */
function useOptionalMetaStore(): any {
  try {
    return useWavesmithMetaStore()
  } catch {
    return null
  }
}
