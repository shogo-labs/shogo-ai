// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useSyncExternalStore } from 'react'
import { useWorkspaceCollection } from '../contexts/domain'
import {
  getActiveWorkspaceId,
  resolveActiveWorkspaceId,
  subscribeActiveWorkspaceId,
} from '../lib/workspace-store'

/**
 * Returns the workspace the user last selected, falling back to the first
 * workspace when nothing has been persisted yet, or when the persisted id
 * isn't one of this user's own workspaces (e.g. left over from a different
 * account signed in earlier on this browser/device).
 */
export function useActiveWorkspace() {
  const workspaces = useWorkspaceCollection()
  const persistedId = useSyncExternalStore(
    subscribeActiveWorkspaceId,
    getActiveWorkspaceId,
    getActiveWorkspaceId,
  )
  const all = workspaces?.all ?? []
  const ownIds = all.map((w: any) => w.id)
  const resolvedId = resolveActiveWorkspaceId(ownIds, persistedId)

  if (resolvedId) {
    const match = all.find((w: any) => w.id === resolvedId)
    if (match) return match
  }

  return all.length > 0 ? all[0] : null
}
