/**
 * Mobile Domain Context
 *
 * Thin wrapper around the shared SDKDomainProvider from @shogo/shared-app.
 * Provides platform-specific API URL and credentials config.
 */

import type { ReactNode } from 'react'
import { SDKDomainProvider } from '@shogo/shared-app/domain'
import { useAuth } from './auth'
import { API_URL } from '../lib/api'

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

export function DomainProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  return (
    <SDKDomainProvider
      apiBaseUrl={API_URL!}
      userId={user?.id ?? null}
      credentials="include"
    >
      {children}
    </SDKDomainProvider>
  )
}
