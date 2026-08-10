// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { getActiveWorkspaceId } from './workspace-store'

/**
 * Query params for `ProjectCollection.loadAll` scoped to the active workspace.
 *
 * This list is workspace-wide, but callers narrow it to the current user
 * (`AppSidebar`'s "mine" scope filters on `createdBy`). A `limit` here therefore
 * cannot be a page of the workspace: in a 212-project shared workspace, capping
 * to the 50 newest hid every project belonging to 11 of its 12 creators. Bound
 * this only once the server can scope the page to the requesting user.
 */
export function workspaceProjectFilter(
  workspaceId?: string | null,
): { workspaceId: string } | undefined {
  const id = workspaceId ?? getActiveWorkspaceId()
  return id ? { workspaceId: id } : undefined
}
