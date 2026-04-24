// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared SDKDomainProvider
 *
 * Creates and manages an MST domain store backed by the SDK HttpClient.
 * Used by both web and mobile apps. The only difference between environments
 * is the apiBaseUrl, which is injected via props.
 *
 * Remote Control Integration:
 * When `remoteProxyBaseUrl` is provided, the HttpClient is wrapped with a
 * remote-aware interceptor that routes stateful API requests (projects,
 * chat sessions, etc.) through the instance tunnel to the desktop app.
 * This makes the desktop the source of truth while connected.
 */

import { createContext, useContext, useRef, useEffect, useState, useMemo, useCallback, type ReactNode } from 'react'
import { HttpClient } from '@shogo-ai/sdk'
import {
  createDomainStore,
  resetDomainStore,
  ChatMessageCollection,
  type IChatMessageCollection,
  type IDomainStore,
  type ISDKEnvironment,
} from '@shogo/domain-stores'
import {
  createRemoteAwareHttpClient,
  type RemoteInterceptorConfig,
} from '../services/remote-http-interceptor'

let moduleRawHttpClient: HttpClient | null = null
let moduleProxiedHttpClient: HttpClient | null = null
let moduleRemoteConfigRef: { current: RemoteInterceptorConfig } | null = null
let moduleStore: IDomainStore | null = null
let moduleFacades: SDKDomainFacades | null = null
let moduleUserId: string | null = null
let moduleEnv: ISDKEnvironment | null = null

// Per-session ChatMessageCollection instances, keyed by sessionId.
// The root-store `chatMessageCollection` is a single bag that gets clobbered
// whenever any panel calls `loadPage({ sessionId })`, so we hand out scoped
// collections instead — each session owns its own MST tree and HTTP loads
// don't step on sibling panels.
const sessionChatCollections = new Map<string, IChatMessageCollection>()

function clearSessionChatCollections() {
  sessionChatCollections.clear()
}

/**
 * Get or create the singleton domain store.
 *
 * CRITICAL: The MST store's environment `env.http` must be the PROXIED
 * HttpClient (not the raw one) so that every collection action
 * (`loadAll`, `create`, `update`, `delete`) goes through the remote
 * interceptor when a desktop instance is connected.
 *
 * The proxy reads its config from `remoteConfigRef` on every request,
 * so we only need to create it once — config changes are picked up
 * automatically via the ref.
 */
function getOrCreateStore(
  apiBaseUrl: string,
  userId: string | null,
  remoteConfigRef: { current: RemoteInterceptorConfig },
  credentials?: RequestCredentials,
  getAuthCookie?: () => string | null,
): {
  rawHttp: HttpClient
  http: HttpClient
  store: IDomainStore
  facades: SDKDomainFacades
} {
  // Always keep the module-level config ref in sync so the proxy
  // (which reads from moduleRemoteConfigRef) picks up the latest
  // React-managed config even across singleton reuse paths.
  moduleRemoteConfigRef = remoteConfigRef

  if (moduleStore !== null && moduleUserId === userId) {
    return { rawHttp: moduleRawHttpClient!, http: moduleProxiedHttpClient!, store: moduleStore, facades: moduleFacades! }
  }

  if (moduleStore !== null && moduleUserId !== userId) {
    moduleUserId = userId
    moduleStore.clearAll()
    clearSessionChatCollections()
    return { rawHttp: moduleRawHttpClient!, http: moduleProxiedHttpClient!, store: moduleStore, facades: moduleFacades! }
  }

  moduleUserId = userId
  moduleRemoteConfigRef = remoteConfigRef

  moduleRawHttpClient = new HttpClient({
    baseUrl: apiBaseUrl,
    getToken: () => null,
    credentials,
    getAuthCookie,
  })

  // Create the remote-aware proxy BEFORE creating the MST store.
  // This ensures getEnv(self).http inside every collection action
  // goes through the interceptor and routes to desktop when connected.
  moduleProxiedHttpClient = createRemoteAwareHttpClient(
    moduleRawHttpClient,
    () => moduleRemoteConfigRef!.current,
  )

  const env: ISDKEnvironment = {
    http: moduleProxiedHttpClient, // ← PROXIED, not raw
    context: userId ? { userId } : undefined,
  }

  moduleEnv = env
  moduleStore = createDomainStore(env)
  moduleFacades = createDomainFacades(moduleStore)

  return { rawHttp: moduleRawHttpClient, http: moduleProxiedHttpClient, store: moduleStore, facades: moduleFacades }
}

function createDomainFacades(store: IDomainStore) {
  return {
    studioCore: {
      workspaceCollection: store.workspaceCollection,
      projectCollection: store.projectCollection,
      memberCollection: store.memberCollection,
      folderCollection: store.folderCollection,
      starredProjectCollection: store.starredProjectCollection,
      invitationCollection: store.invitationCollection,
      notificationCollection: store.notificationCollection,
    },
    billing: {
      subscriptionCollection: store.subscriptionCollection,
      usageWalletCollection: store.usageWalletCollection,
      usageEventCollection: store.usageEventCollection,
      billingAccountCollection: store.billingAccountCollection,
    },
    studioChat: {
      chatSessionCollection: store.chatSessionCollection,
      chatMessageCollection: store.chatMessageCollection,
      toolCallLogCollection: store.toolCallLogCollection,
    },
    _sdk: store,
  }
}

export type SDKDomainFacades = ReturnType<typeof createDomainFacades>

interface SDKDomainContextValue {
  store: IDomainStore
  facades: SDKDomainFacades
  http: HttpClient
  isReady: boolean
  schemasLoading: boolean
  schemasLoaded: boolean
  /** Whether data is being served from a remote desktop instance */
  isRemoteSource: boolean
  /** Last remote error (tunnel disconnect, timeout, etc.) */
  remoteError: string | null
}

const SDKDomainContext = createContext<SDKDomainContextValue | null>(null)

export interface SDKDomainProviderProps {
  apiBaseUrl: string
  userId: string | null
  /** Fetch credentials mode. Set to 'include' for cross-origin cookie auth (mobile). */
  credentials?: RequestCredentials
  /** Function to get auth cookies for native apps (e.g. from expo-secure-store via Better Auth). */
  getAuthCookie?: () => string | null
  /**
   * When set, stateful API requests (projects, chat, etc.) are routed through
   * the instance tunnel to the connected desktop. Set to the transparent proxy
   * base URL: `${apiUrl}/api/instances/${instanceId}/p`
   *
   * When null/undefined, all requests go to the cloud backend (default).
   */
  remoteProxyBaseUrl?: string | null
  /**
   * Called when a remote-routed request fails (e.g. desktop disconnected).
   * Can be used to show a toast or auto-disconnect.
   */
  onRemoteError?: (error: Error, path: string) => void
  children: ReactNode
}

export function SDKDomainProvider({
  apiBaseUrl,
  userId,
  credentials,
  getAuthCookie,
  remoteProxyBaseUrl,
  onRemoteError,
  children,
}: SDKDomainProviderProps) {
  const [isReady, setIsReady] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const prevUserIdRef = useRef<string | null | undefined>(undefined)
  const prevRemoteUrlRef = useRef<string | null | undefined>(undefined)

  // ─── Remote config ref ──────────────────────────────────────────────
  // The ref is shared with the module-level proxy created in
  // getOrCreateStore(). Updating it here reactively re-targets ALL
  // HTTP calls — both from React hooks (useSDKHttp) AND from MST
  // collection actions (getEnv(self).http).
  const remoteConfigRef = useRef<RemoteInterceptorConfig>({
    remoteProxyBaseUrl: remoteProxyBaseUrl ?? null,
  })

  const handleRemoteError = useCallback(
    (error: Error, path: string) => {
      const msg = `Remote request failed: ${error.message}`
      console.warn(`[SDKDomainProvider] ${msg} (path: ${path})`)
      setRemoteError(msg)
      onRemoteError?.(error, path)
    },
    [onRemoteError],
  )

  // Update the ref whenever the remote config changes
  remoteConfigRef.current = {
    remoteProxyBaseUrl: remoteProxyBaseUrl ?? null,
    protocolVersion: 3,     // matches TUNNEL_PROTOCOL_VERSION
    syncVersion: 1,         // sync event schema version
    clientVersion: '0.1.0',
    onRemoteError: handleRemoteError,
  }

  const { http, store, facades } = getOrCreateStore(
    apiBaseUrl, userId, remoteConfigRef, credentials, getAuthCookie,
  )

  // When remote connection changes, clear stale data and hydrate from new source.
  //
  // CRITICAL: The hydration order is SNAPSHOT FIRST, then events.
  // 1. Clear stale collections
  // 2. Trigger loadAll() on each collection (fetches from the new source)
  // 3. Only AFTER snapshot is loaded should sync events be applied
  //
  // This guarantees the UI always shows a consistent state and never
  // displays stale cloud data while connected to a desktop.
  useEffect(() => {
    const prevUrl = prevRemoteUrlRef.current
    const currentUrl = remoteProxyBaseUrl ?? null

    if (prevUrl !== undefined && prevUrl !== currentUrl) {
      // Clear stale data from the previous source
      store.projectCollection.clear()
      store.folderCollection.clear()
      store.starredProjectCollection.clear()
      store.chatSessionCollection.clear()
      store.chatMessageCollection.clear()
      store.toolCallLogCollection.clear()
      clearSessionChatCollections()
      setRemoteError(null)

      // 2. Hydrate from new source (snapshot fetch).
      //    loadAll() on each collection triggers GET /api/projects etc.
      //    When remote is active, the interceptor rewrites these to the
      //    tunnel, so we get desktop data. When remote is off, we get
      //    cloud data. Fire-and-forget — each collection manages its
      //    own loading state.
      // We don’t call loadAll() here directly — the UI pages already
      // call loadAll() on mount. Clearing the collection + changing the
      // HttpClient target is enough to trigger a re-fetch on the next
      // render cycle. This avoids double-fetching.
    }

    prevRemoteUrlRef.current = currentUrl
  }, [remoteProxyBaseUrl, store])

  useEffect(() => {
    prevUserIdRef.current = userId
  }, [userId])

  useEffect(() => { setIsReady(true) }, [])

  const isRemoteSource = !!remoteProxyBaseUrl

  const contextValue = useMemo<SDKDomainContextValue>(
    () => ({
      store,
      facades,
      http,
      isReady,
      schemasLoading: false,
      schemasLoaded: isReady,
      isRemoteSource,
      remoteError,
    }),
    [store, facades, http, isReady, isRemoteSource, remoteError],
  )

  return (
    <SDKDomainContext.Provider value={contextValue}>
      {children}
    </SDKDomainContext.Provider>
  )
}

export function useSDKDomain(): IDomainStore {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useSDKDomain must be used within SDKDomainProvider')
  return ctx.store
}

export function useSDKDomains(): SDKDomainFacades {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useSDKDomains must be used within SDKDomainProvider')
  return ctx.facades
}

export function useSDKHttp(): HttpClient {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useSDKHttp must be used within SDKDomainProvider')
  return ctx.http
}

export function useSDKReady() {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useSDKReady must be used within SDKDomainProvider')
  return { isReady: ctx.isReady, schemasLoading: ctx.schemasLoading, schemasLoaded: ctx.schemasLoaded }
}

export function useWorkspaceCollection() { return useSDKDomain().workspaceCollection }
export function useProjectCollection() { return useSDKDomain().projectCollection }
export function useMemberCollection() { return useSDKDomain().memberCollection }
export function useFolderCollection() { return useSDKDomain().folderCollection }
export function useStarredProjectCollection() { return useSDKDomain().starredProjectCollection }
export function useInvitationCollection() { return useSDKDomain().invitationCollection }
export function useNotificationCollection() { return useSDKDomain().notificationCollection }
export function useSubscriptionCollection() { return useSDKDomain().subscriptionCollection }
export function useChatSessionCollection() { return useSDKDomain().chatSessionCollection }
export function useChatMessageCollection() { return useSDKDomain().chatMessageCollection }

/**
 * Returns whether data is currently being served from a remote desktop instance.
 * Use this to show UI indicators like "Connected to Desktop" or to conditionally
 * hide cloud-only features.
 */
export function useIsRemoteSource(): boolean {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useIsRemoteSource must be used within SDKDomainProvider')
  return ctx.isRemoteSource
}

/**
 * Returns the last remote error message, or null if no error.
 * Resets when the remote connection changes.
 */
export function useRemoteError(): string | null {
  const ctx = useContext(SDKDomainContext)
  if (!ctx) throw new Error('useRemoteError must be used within SDKDomainProvider')
  return ctx.remoteError
}

export function resetSDKDomainStore(): void {
  moduleRawHttpClient = null
  moduleProxiedHttpClient = null
  moduleRemoteConfigRef = null
  moduleStore = null
  moduleFacades = null
  moduleUserId = null
  moduleEnv = null
  clearSessionChatCollections()
  resetDomainStore()
}

/**
 * Get (or lazily create) a ChatMessageCollection scoped to a single session.
 *
 * The root-store `chatMessageCollection` is a singleton bag. When multiple
 * ChatPanel instances render for different sessions, each `loadPage({ sessionId })`
 * clobbers the previous session's data, causing the other panels' derived
 * `all.filter(sessionId === mine)` to drop to 0 and trigger a flicker.
 *
 * Per-session collections own their own MST tree so `loadPage`, `.all`,
 * `hasMore`, `isLoadingMore`, and `update()` are all isolated. They share the
 * same HTTP environment as the root store, so remote-proxy routing still works.
 *
 * Instances are cached for the lifetime of the user's session. They are
 * evicted on user change, remote-source switch, and `resetSDKDomainStore()`.
 */
export function getChatMessageCollectionForSession(
  sessionId: string,
): IChatMessageCollection {
  let collection = sessionChatCollections.get(sessionId)
  if (collection) return collection
  if (!moduleEnv) {
    throw new Error(
      '[SDKDomainProvider] SDK environment not initialised. ' +
        'Call getChatMessageCollectionForSession() only inside an <SDKDomainProvider>.',
    )
  }
  collection = ChatMessageCollection.create({ items: {} }, moduleEnv)
  sessionChatCollections.set(sessionId, collection)
  return collection
}

/**
 * React hook form of {@link getChatMessageCollectionForSession}. Returns null
 * when `sessionId` is null/undefined (e.g. no chat is selected yet).
 */
export function useChatMessageCollectionForSession(
  sessionId: string | null | undefined,
): IChatMessageCollection | null {
  return useMemo(
    () => (sessionId ? getChatMessageCollectionForSession(sessionId) : null),
    [sessionId],
  )
}

// Re-export useDomainActions hook (was previously in domain-stores but moved here to avoid circular deps)
import { createDomainActions } from '@shogo/domain-stores/domain-actions'

export function useDomainActions() {
  const store = useSDKDomain() as IDomainStore
  return useMemo(() => createDomainActions(store), [store])
}
