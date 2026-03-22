// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared SDKDomainProvider
 *
 * Creates and manages an MST domain store backed by the SDK HttpClient.
 * Used by both web and mobile apps. The only difference between environments
 * is the apiBaseUrl, which is injected via props.
 */

import { createContext, useContext, useRef, useEffect, useState, useMemo, type ReactNode } from 'react'
import { HttpClient } from '@shogo-ai/sdk'
import {
  createDomainStore,
  resetDomainStore,
  type IDomainStore,
  type ISDKEnvironment,
} from '@shogo/domain-stores'

let moduleHttpClient: HttpClient | null = null
let moduleStore: IDomainStore | null = null
let moduleFacades: SDKDomainFacades | null = null
let moduleUserId: string | null = null

function getOrCreateStore(
  apiBaseUrl: string,
  userId: string | null,
  credentials?: RequestCredentials,
  getAuthCookie?: () => string | null,
): {
  http: HttpClient
  store: IDomainStore
  facades: SDKDomainFacades
} {
  if (moduleStore !== null && moduleUserId === userId) {
    return { http: moduleHttpClient!, store: moduleStore, facades: moduleFacades! }
  }

  if (moduleStore !== null && moduleUserId !== userId) {
    moduleUserId = userId
    moduleStore.clearAll()
    return { http: moduleHttpClient!, store: moduleStore, facades: moduleFacades! }
  }

  moduleUserId = userId

  moduleHttpClient = new HttpClient({
    baseUrl: apiBaseUrl,
    getToken: () => null,
    credentials,
    getAuthCookie,
  })

  const env: ISDKEnvironment = {
    http: moduleHttpClient,
    context: userId ? { userId } : undefined,
  }

  moduleStore = createDomainStore(env)
  moduleFacades = createDomainFacades(moduleStore)

  return { http: moduleHttpClient, store: moduleStore, facades: moduleFacades }
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
      creditLedgerCollection: store.creditLedgerCollection,
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
}

const SDKDomainContext = createContext<SDKDomainContextValue | null>(null)

export interface SDKDomainProviderProps {
  apiBaseUrl: string
  userId: string | null
  /** Fetch credentials mode. Set to 'include' for cross-origin cookie auth (mobile). */
  credentials?: RequestCredentials
  /** Function to get auth cookies for native apps (e.g. from expo-secure-store via Better Auth). */
  getAuthCookie?: () => string | null
  children: ReactNode
}

export function SDKDomainProvider({ apiBaseUrl, userId, credentials, getAuthCookie, children }: SDKDomainProviderProps) {
  const [isReady, setIsReady] = useState(false)
  const prevUserIdRef = useRef<string | null | undefined>(undefined)

  const { http, store, facades } = getOrCreateStore(apiBaseUrl, userId, credentials, getAuthCookie)

  useEffect(() => {
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
      console.log('[SDKDomainProvider] User changed, collections cleared')
    }
    prevUserIdRef.current = userId
  }, [userId])

  useEffect(() => { setIsReady(true) }, [])

  const contextValue = useMemo<SDKDomainContextValue>(
    () => ({ store, facades, http, isReady, schemasLoading: false, schemasLoaded: isReady }),
    [store, facades, http, isReady]
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

export function resetSDKDomainStore(): void {
  moduleHttpClient = null
  moduleStore = null
  moduleFacades = null
  moduleUserId = null
  resetDomainStore()
}

// Re-export useDomainActions hook (was previously in domain-stores but moved here to avoid circular deps)
import { createDomainActions } from '@shogo/domain-stores/domain-actions'

export function useDomainActions() {
  const store = useSDKDomain() as IDomainStore
  return useMemo(() => createDomainActions(store), [store])
}
