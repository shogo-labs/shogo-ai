// SPDX-License-Identifier: MIT
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
import { computeRemoteProxyBaseUrl } from '@shogo/shared-app/hooks'
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
  useNotificationCollection,
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
  const { instance, remoteAgentBaseUrl } = useActiveInstance()

  const getAuthCookie = useCallback(() => {
    return authClient.getCookie() || null
  }, [])

  // The HTTP interceptor wraps Studio's HttpClient and rewrites stateful
  // API calls (`/api/projects`, `/api/chat-sessions`, etc.) to flow
  // through the cloud's transparent proxy `/api/instances/<id>/p/*` and
  // out the WebSocket tunnel to the remote machine. That round-trip
  // assumes the remote machine hosts an apps/api with a project
  // database — which is true for the desktop adapter, but NOT for a
  // `shogo worker` cli-worker on a self-hosted VPS. cli-worker
  // instances are execution targets only; their `RuntimeResolver`
  // returns null for any non-`/agent/*` path and the tunnel responds
  // 502 with `code: 'CLI_WORKER_HAS_NO_DATA_API'`. Keeping the
  // interceptor active for cli-workers is therefore guaranteed to
  // brick Studio's sidebar.
  //
  // `computeRemoteProxyBaseUrl` is the canonical decision matrix —
  // see its doc-comment in `useActiveInstance.tsx`. Note that
  // `remoteAgentBaseUrl` is *intentionally* still surfaced for
  // cli-workers (and consumed by the per-project layout to construct
  // `${remoteAgentBaseUrl}/api/projects/<id>/agent-proxy/agent/*`);
  // Patch C scope is narrow on purpose, gating only the
  // SDKDomainProvider's stateful-data routing.
  const remoteProxyBaseUrl = computeRemoteProxyBaseUrl(instance, remoteAgentBaseUrl)

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
