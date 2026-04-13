// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mobile Domain Context
 *
 * Thin wrapper around the shared SDKDomainProvider from @shogo/shared-app.
 * Provides platform-specific API URL and credentials config.
 *
 * On native (Android/iOS), retrieves auth cookies from SecureStore via
 * Better Auth's expoClient plugin and passes them as headers (instead of
 * relying on browser-style credential cookies).
 */

import { useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { SDKDomainProvider } from '@shogo/shared-app/domain'
import { useAuth } from './auth'
import { useActiveInstance } from './active-instance'
import { API_URL } from '../lib/api'
import { authClient } from '../lib/auth-client'

export {
  useSDKDomain as useDomain,
  useSDKHttp as useDomainHttp,
  useSDKReady as useDomainReady,
  useProjectCollection,
  useWorkspaceCollection,
  useMemberCollection,
  useFolderCollection,
  useStarredProjectCollection,
  useInvitationCollection,
  useChatSessionCollection,
  useChatMessageCollection,
  useDomainActions,
} from '@shogo/shared-app/domain'

export type { IDomainStore } from '@shogo/domain-stores'
export type { IProject } from '@shogo/domain-stores'
export type { IWorkspace } from '@shogo/domain-stores'
export type { IMember } from '@shogo/domain-stores'

const isNative = Platform.OS !== 'web'

export function DomainProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { remoteAgentBaseUrl } = useActiveInstance()

  const getAuthCookie = useCallback(() => {
    return authClient.getCookie() || null
  }, [])

  // When a remote desktop instance is selected, remoteAgentBaseUrl is
  // e.g. "https://studio.shogo.ai/api/instances/<id>/p".
  // Passing it as remoteProxyBaseUrl activates the HTTP interceptor which
  // rewrites stateful API calls (projects, chat, etc.) to go through the
  // tunnel to the desktop instead of hitting the cloud backend directly.
  const remoteProxyBaseUrl = remoteAgentBaseUrl ?? null

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[DomainProvider] remoteProxyBaseUrl:', remoteProxyBaseUrl)
  }

  return (
    <SDKDomainProvider
      apiBaseUrl={API_URL!}
      userId={user?.id ?? null}
      credentials={isNative ? 'omit' : 'include'}
      getAuthCookie={isNative ? getAuthCookie : undefined}
      remoteProxyBaseUrl={remoteProxyBaseUrl}
      onRemoteError={(error, path) => {
        console.warn('[DomainProvider] Remote request failed:', path, error.message)
      }}
    >
      {children}
    </SDKDomainProvider>
  )
}
