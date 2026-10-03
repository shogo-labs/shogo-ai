// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useSyncExternalStore } from 'react'
import { useAuth } from '../contexts/auth'
import { getActiveWorkspaceId, subscribeActiveWorkspaceId } from '../lib/workspace-store'
import { isCloudWorkspace, useCloudWorkspaces } from '../lib/workspace-route'

export interface WorkspaceUser {
  id: string
  name: string | null
  email: string | null
  source: 'local' | 'cloud'
}

/**
 * Who the user is in the active workspace. On desktop, a cloud workspace
 * shows them as their Shogo Cloud account. The id stays the local one: the
 * desktop API swaps it for the cloud id in both directions.
 */
export function useWorkspaceUser(workspaceId?: string | null): WorkspaceUser | null {
  const { user } = useAuth()
  const cloud = useCloudWorkspaces()
  const activeId = useSyncExternalStore(subscribeActiveWorkspaceId, getActiveWorkspaceId, getActiveWorkspaceId)
  const id = workspaceId ?? activeId
  const local = user as { id?: string; name?: string | null; email?: string | null } | null
  if (isCloudWorkspace(id)) {
    return cloud.user && local?.id
      ? { id: local.id, name: cloud.user.name, email: cloud.user.email, source: 'cloud' }
      : null
  }
  return local?.id ? { id: local.id, name: local.name ?? null, email: local.email ?? null, source: 'local' } : null
}
