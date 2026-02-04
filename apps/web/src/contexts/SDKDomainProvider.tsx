/**
 * SDK-based DomainProvider
 *
 * This provider uses SDK-generated MST stores and provides backward
 * compatibility with the existing useDomains() API.
 *
 * The SDK generates a single DomainStore with all collections.
 * This provider maps those collections to the domain structure
 * expected by existing components.
 *
 * Usage:
 * ```tsx
 * // In App.tsx
 * <SDKDomainProvider>
 *   <YourComponents />
 * </SDKDomainProvider>
 *
 * // In components - use new API
 * const store = useSDKDomain()
 * const workspaces = store.workspaceCollection.all
 *
 * // Or use backward-compatible API
 * const { studioCore } = useSDKDomains()
 * const workspaces = studioCore.workspaceCollection.all
 * ```
 */

import { createContext, useContext, useRef, useEffect, useState, useMemo, type ReactNode } from 'react'
import { HttpClient } from '@shogo-ai/sdk'
import { useSession } from './SessionProvider'
import {
  createDomainStore,
  resetDomainStore,
  type IDomainStore,
  type ISDKEnvironment,
} from '../generated/domain'

// ============================================================================
// Configuration
// ============================================================================

// Use the same API URL as the app
// When VITE_API_URL is not set, use current origin for same-origin requests
const API_BASE_URL = import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '')

// ============================================================================
// Module-level store management
// ============================================================================

// Store instances at module level to avoid recreating during render
let moduleHttpClient: HttpClient | null = null
let moduleStore: IDomainStore | null = null
let moduleFacades: SDKDomainFacades | null = null
let moduleUserId: string | null = null

/**
 * Initialize or get the store. This is called outside of render to avoid
 * MST initialization issues during React's render phase.
 */
function getOrCreateStore(userId: string | null): {
  http: HttpClient
  store: IDomainStore
  facades: SDKDomainFacades
} {
  // If user hasn't changed and we have a store, return it
  if (moduleStore !== null && moduleUserId === userId) {
    return {
      http: moduleHttpClient!,
      store: moduleStore,
      facades: moduleFacades!,
    }
  }

  // User changed - clear collections instead of recreating the store
  // This preserves the store instance and avoids detached node errors
  if (moduleStore !== null && moduleUserId !== userId) {
    moduleUserId = userId
    // Clear all collections - this removes items but keeps the store structure
    moduleStore.clearAll()
    return {
      http: moduleHttpClient!,
      store: moduleStore,
      facades: moduleFacades!,
    }
  }

  // First-time initialization
  moduleUserId = userId

  // Create HttpClient with credentials for cookie-based auth
  moduleHttpClient = new HttpClient({
    baseUrl: API_BASE_URL,
    getToken: () => null, // Token is handled via cookies/session
    defaultHeaders: {
      'Content-Type': 'application/json',
    },
  })

  // Create environment
  const env: ISDKEnvironment = {
    http: moduleHttpClient,
    context: userId ? { userId } : undefined,
  }

  // Create domain store
  moduleStore = createDomainStore(env)

  // Create facades for backward compatibility
  moduleFacades = createDomainFacades(moduleStore)

  return {
    http: moduleHttpClient,
    store: moduleStore,
    facades: moduleFacades,
  }
}

// ============================================================================
// Domain Facades (Backward Compatibility)
// ============================================================================

/**
 * Create facade objects that map old domain names to SDK collections.
 * This allows existing code using useDomains().studioCore to keep working.
 */
function createDomainFacades(store: IDomainStore) {
  return {
    // studioCore domain - workspace, project, member, folder, starred, invitation, notification
    studioCore: {
      workspaceCollection: store.workspaceCollection,
      projectCollection: store.projectCollection,
      memberCollection: store.memberCollection,
      folderCollection: store.folderCollection,
      starredProjectCollection: store.starredProjectCollection,
      invitationCollection: store.invitationCollection,
      notificationCollection: store.notificationCollection,
    },

    // billing domain - subscription, creditLedger, usageEvent, billingAccount
    billing: {
      subscriptionCollection: store.subscriptionCollection,
      creditLedgerCollection: store.creditLedgerCollection,
      usageEventCollection: store.usageEventCollection,
      billingAccountCollection: store.billingAccountCollection,
    },

    // studioChat domain - chatSession, chatMessage, toolCallLog
    studioChat: {
      chatSessionCollection: store.chatSessionCollection,
      chatMessageCollection: store.chatMessageCollection,
      toolCallLogCollection: store.toolCallLogCollection,
    },

    // Direct access to SDK store (for migration)
    _sdk: store,
  }
}

export type SDKDomainFacades = ReturnType<typeof createDomainFacades>

// ============================================================================
// Context
// ============================================================================

interface SDKDomainContextValue {
  store: IDomainStore
  facades: SDKDomainFacades
  http: HttpClient
  isReady: boolean
  schemasLoading: boolean
  schemasLoaded: boolean
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
 * Clears collections (instead of recreating store) when user changes.
 * Provides backward-compatible facades for existing useDomains() code.
 */
export function SDKDomainProvider({ children }: SDKDomainProviderProps) {
  const session = useSession()
  const [isReady, setIsReady] = useState(false)
  const prevUserIdRef = useRef<string | null | undefined>(undefined)

  // Get current user ID
  const currentUserId = session.data?.user?.id ?? null

  // Get or create the store instance (module-level, stable across renders)
  // This is safe because it doesn't create new observables during render -
  // it either returns existing ones or initializes them once at module level
  const { http, store, facades } = getOrCreateStore(currentUserId)

  // Handle user changes by clearing collections in an effect (not during render)
  useEffect(() => {
    const prevUserId = prevUserIdRef.current

    // Skip on initial mount
    if (prevUserId !== undefined && prevUserId !== currentUserId) {
      // User changed - collections are already cleared by getOrCreateStore
      // but we log it here for debugging
      console.log('[SDKDomainProvider] User changed, collections cleared')
    }

    prevUserIdRef.current = currentUserId
  }, [currentUserId])

  // Mark as ready on mount
  useEffect(() => {
    setIsReady(true)
  }, [])

  const contextValue = useMemo<SDKDomainContextValue>(
    () => ({
      store,
      facades,
      http,
      isReady,
      // For SchemaLoadingGate compatibility
      schemasLoading: false,
      schemasLoaded: isReady,
    }),
    [store, facades, http, isReady]
  )

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
 * Hook to access the SDK domain store directly.
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
 * Hook to access domains with backward-compatible structure.
 * Maps SDK collections to old domain names (studioCore, billing, etc.)
 *
 * @throws Error if used outside SDKDomainProvider
 * @returns Object with domain facades
 *
 * @example
 * ```tsx
 * // Same API as old useDomains()
 * const { studioCore, billing, studioChat } = useSDKDomains()
 * const workspaces = studioCore.workspaceCollection.all
 * ```
 */
export function useSDKDomains(): SDKDomainFacades {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) {
    throw new Error('useSDKDomains must be used within SDKDomainProvider')
  }
  return ctx.facades
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
 * Compatible with useSchemaLoadingState() from old DomainProvider.
 */
export function useSDKReady(): { isReady: boolean; schemasLoading: boolean; schemasLoaded: boolean } {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) {
    throw new Error('useSDKReady must be used within SDKDomainProvider')
  }
  return {
    isReady: ctx.isReady,
    schemasLoading: ctx.schemasLoading,
    schemasLoaded: ctx.schemasLoaded,
  }
}

// ============================================================================
// Convenience Hooks for Collections
// ============================================================================

/** Hook to access the workspace collection */
export function useWorkspaceCollection() {
  return useSDKDomain().workspaceCollection
}

/** Hook to access the project collection */
export function useProjectCollection() {
  return useSDKDomain().projectCollection
}

/** Hook to access the member collection */
export function useMemberCollection() {
  return useSDKDomain().memberCollection
}

/** Hook to access the folder collection */
export function useFolderCollection() {
  return useSDKDomain().folderCollection
}

/** Hook to access the starred project collection */
export function useStarredProjectCollection() {
  return useSDKDomain().starredProjectCollection
}

/** Hook to access the invitation collection */
export function useInvitationCollection() {
  return useSDKDomain().invitationCollection
}

/** Hook to access the notification collection */
export function useNotificationCollection() {
  return useSDKDomain().notificationCollection
}

/** Hook to access the subscription collection */
export function useSubscriptionCollection() {
  return useSDKDomain().subscriptionCollection
}

/** Hook to access the chat session collection */
export function useChatSessionCollection() {
  return useSDKDomain().chatSessionCollection
}

/** Hook to access the chat message collection */
export function useChatMessageCollection() {
  return useSDKDomain().chatMessageCollection
}

// ============================================================================
// Testing Utilities
// ============================================================================

/**
 * Reset the module-level store (for testing purposes only).
 * This completely recreates the store on the next getOrCreateStore call.
 */
export function resetSDKDomainStore(): void {
  moduleHttpClient = null
  moduleStore = null
  moduleFacades = null
  moduleUserId = null
  resetDomainStore()
}
