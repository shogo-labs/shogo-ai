// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Whether /api/me should show the admin portal entry. Full super admins and
 * users with any assigned scope both get in; the portal filters surfaces.
 */
export function hasAdminPortalAccess(me: {
  ok?: boolean
  data?: { role?: string | null; adminScopes?: unknown }
} | null | undefined): boolean {
  if (!me?.ok) return false
  if (me.data?.role === "super_admin") return true
  return Array.isArray(me.data?.adminScopes) && me.data.adminScopes.length > 0
}
