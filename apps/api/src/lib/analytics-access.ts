// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace analytics are owner/admin only.
 *
 * Every workspace-wide read — `/workspaces/:id/analytics/*`,
 * `/projects/:id/analytics/*` and `/workspaces/:id/cost-analytics/*` — needs
 * `workspace.analytics:read`, which only `owner` and `admin` hold. A member's
 * own numbers live on `/me/analytics/*` (Profile → Usage), which is personal
 * and stays open to everyone.
 */

import type { Context } from 'hono'
import { can } from './authz'

/** The one 403 body every analytics read returns to a non-admin. */
export const ANALYTICS_ADMIN_ONLY = {
  error: {
    code: 'analytics_admin_only',
    message: 'Workspace analytics are only available to workspace admins',
  },
} as const

/** True when the caller may read this workspace's analytics. */
export function canReadWorkspaceAnalytics(c: Context, workspaceId: string): Promise<boolean> {
  return can(c, 'workspace.analytics:read', { workspaceId })
}
