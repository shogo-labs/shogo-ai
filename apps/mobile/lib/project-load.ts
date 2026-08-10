// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { getActiveWorkspaceId } from './workspace-store'

/**
 * Upper bound on the workspace-scoped project list. Matches
 * `ProjectCollection.loadPage`'s default page size.
 *
 * Without a bound, `GET /api/projects` returns the entire workspace on every
 * app load — 155 KB for 55 rows in production, to render a sidebar that shows
 * five names before collapsing the rest behind a toggle.
 */
const PROJECT_LIST_LIMIT = 50

/** Query params for `ProjectCollection.loadAll` scoped to the active workspace. */
export function workspaceProjectFilter(
  workspaceId?: string | null,
): { workspaceId: string; limit: string; orderBy: string } | undefined {
  const id = workspaceId ?? getActiveWorkspaceId()
  if (!id) return undefined
  // `orderBy` has to travel with `limit`. The list route only honours an
  // explicit `orderBy` query param and otherwise leaves ordering to the
  // database, so a capped query without one returns an arbitrary slice rather
  // than the newest projects.
  return {
    workspaceId: id,
    limit: String(PROJECT_LIST_LIMIT),
    orderBy: 'createdAt:desc',
  }
}
