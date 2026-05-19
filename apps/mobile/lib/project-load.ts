// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { getActiveWorkspaceId } from './workspace-store'

/** Query params for `ProjectCollection.loadAll` scoped to the active workspace. */
export function workspaceProjectFilter(
  workspaceId?: string | null,
): { workspaceId: string } | undefined {
  const id = workspaceId ?? getActiveWorkspaceId()
  return id ? { workspaceId: id } : undefined
}
