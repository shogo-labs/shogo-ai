/**
 * SDK-based DomainProvider
 *
 * This is the new provider that uses SDK-generated MST stores.
 * It can coexist with the existing DomainProvider during migration.
 *
 * Usage:
 * ```tsx
 * import { SDKDomainProvider, useSDKDomain } from './contexts/SDKDomainProvider'
 *
 * // In App.tsx
 * <SDKDomainProvider>
 *   <YourComponents />
 * </SDKDomainProvider>
 *
 * // In components
 * const store = useSDKDomain()
 * const workspaces = store.workspaceCollection.all
 * ```
 */

import { createContext, useContext, useRef, useEffect, useState, type ReactNode } from 'react'
import { HttpClient } from '@shogo/sdk'
import { useSession } from './SessionProvider'
import {
  createDomainStore,
  type IDomainStore,
  type ISDKEnvironment,
} from '../generated/domain'

// ============================================================================
// Configuration
// ============================================================================

// Use the same API URL as the app
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

// ============================================================================
// Context
// ============================================================================

interface SDKDomainContextValue {
  store: IDomainStore
  http: HttpClient
  isReady: boolean
}

const SDKDomainContext = createContext<SDKDomainContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface SDKDomainProviderProps {
  children: ReactNode
}

/**
 * Provider for SDK-generated MST stores.
 *
 * Creates an HttpClient and domain store, providing them to all children.
 * Recreates the store when the user changes (via session).
 */
export function SDKDomainProvider({ children }: SDKDomainProviderProps) {
  const session = useSession()
  const httpRef = useRef<HttpClient | null>(null)
  const storeRef = useRef<IDomainStore | null>(null)
  const userIdRef = useRef<string | null>(null)
  const [isReady, setIsReady] = useState(false)

  // Get current user ID
  const currentUserId = session.data?.user?.id ?? null

  // Create or recreate when user changes
  if (httpRef.current === null || userIdRef.current !== currentUserId) {
    userIdRef.current = currentUserId

    // Create HttpClient
    httpRef.current = new HttpClient({
      baseUrl: API_BASE_URL,
      getToken: () => null, // Token is handled via cookies/session
    })

    // Create environment
    const env: ISDKEnvironment = {
      http: httpRef.current,
      context: currentUserId ? { userId: currentUserId } : undefined,
    }

    // Create domain store
    storeRef.current = createDomainStore(env)
  }

  // Mark as ready on mount
  useEffect(() => {
    setIsReady(true)
  }, [])

  const contextValue: SDKDomainContextValue = {
    store: storeRef.current!,
    http: httpRef.current!,
    isReady,
  }

  return (
    <SDKDomainContext.Provider value={contextValue}>
      {children}
    </SDKDomainContext.Provider>
  )
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access the SDK domain store.
 *
 * @throws Error if used outside SDKDomainProvider
 * @returns The domain store instance
 */
export function useSDKDomain(): IDomainStore {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) {
    throw new Error('useSDKDomain must be used within SDKDomainProvider')
  }
  return ctx.store
}

/**
 * Hook to access the HTTP client.
 *
 * @throws Error if used outside SDKDomainProvider
 * @returns The HttpClient instance
 */
export function useSDKHttp(): HttpClient {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) {
    throw new Error('useSDKHttp must be used within SDKDomainProvider')
  }
  return ctx.http
}

/**
 * Hook to check if the SDK store is ready.
 */
export function useSDKReady(): { isReady: boolean } {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) {
    throw new Error('useSDKReady must be used within SDKDomainProvider')
  }
  return { isReady: ctx.isReady }
}

// ============================================================================
// Convenience Hooks for Collections
// ============================================================================

/**
 * Hook to access the workspace collection.
 */
export function useWorkspaceCollection() {
  const store = useSDKDomain()
  return store.workspaceCollection
}

/**
 * Hook to access the project collection.
 */
export function useProjectCollection() {
  const store = useSDKDomain()
  return store.projectCollection
}

/**
 * Hook to access the member collection.
 */
export function useMemberCollection() {
  const store = useSDKDomain()
  return store.memberCollection
}

// Add more collection hooks as needed...
