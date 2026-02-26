/**
 * Mobile Domain Context
 *
 * Thin wrapper around the shared SDKDomainProvider from @shogo/shared-app.
 * Provides platform-specific API URL and credentials config.
 *
 * On native (Android/iOS), reads auth cookies from AsyncStorage-backed
 * cookie jar and passes them as headers (instead of relying on
 * browser-style credential cookies).
 */

import { useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { SDKDomainProvider } from '@shogo/shared-app/domain'
import { useAuth } from './auth'
import { API_URL } from '../lib/api'
import { getAuthCookieHeader } from '../lib/auth-storage'

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

const isNative = Platform.OS !== 'web'

export function DomainProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  const getAuthCookie = useCallback(() => {
    return getAuthCookieHeader()
  }, [])

  return (
    <SDKDomainProvider
      apiBaseUrl={API_URL!}
      userId={user?.id ?? null}
      credentials={isNative ? 'omit' : 'include'}
      getAuthCookie={isNative ? getAuthCookie : undefined}
    >
      {children}
    </SDKDomainProvider>
  )
}
