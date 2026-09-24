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
  const resolvedId = resolveActiveWorkspaceId(ownIds, persistedId, {
    // The collection starts empty and may be refreshed while this hook is
    // rendering. A partial list must never overwrite the selected workspace
    // with the first item (which is usually Personal).
    listLoaded: all.length > 0 && !workspaces?.isLoading,
    // This hook runs during render. Explicit post-load callers handle
    // persistence of a genuinely stale id.
    persistFallback: false,
  })

  if (resolvedId) {
    const match = all.find((w: any) => w.id === resolvedId)
    if (match) return match
    // While a refresh is still in flight, `all` may contain only a partial
    // response. Do not render the first item as the active workspace; the
    // workspace experience treats an unloaded kind as the safer team shell.
    if (workspaces?.isLoading) return null
  }

  return all.length > 0 ? all[0] : null
}
