// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useWorkspaceCollection } from '../contexts/domain'
import { getActiveWorkspaceId } from '../lib/workspace-store'

/**
 * Returns the workspace the user last selected, falling back to the first
 * workspace when nothing has been persisted yet.
 */
export function useActiveWorkspace() {
  const workspaces = useWorkspaceCollection()
  const all = workspaces?.all ?? []
  const storedId = getActiveWorkspaceId()

  if (storedId) {
    const match = all.find((w: any) => w.id === storedId)
    if (match) return match
  }

  return all.length > 0 ? all[0] : null
}
