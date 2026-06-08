// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scoped Admin Access Middleware
 *
 * Gates routes by granular admin permission scopes (see ../lib/admin-scopes).
 * A `super_admin` passes every check; other users pass only if they hold the
 * required scope. Use this for admin surfaces that should be delegable to
 * partial admins (e.g. analytics, creator stats). For surfaces that must stay
 * fully privileged (users, workspaces, infrastructure, settings), keep using
 * `requireSuperAdmin`.
 *
 * Must run after authMiddleware + requireAuth.
 *
 * Usage:
 * ```typescript
 * router.use('/analytics/*', requireAdminScope('analytics:read'))
 * router.use('/creators', requireAdminScope('creators:read'))
 * ```
 */

import type { Context, Next } from "hono"
import { getAdminAccess, type AdminScope } from "../lib/admin-scopes"

function unauthorized(c: Context) {
  return c.json(
    { error: { code: "unauthorized", message: "Authentication required" } },
    401
  )
}

function forbidden(c: Context) {
  return c.json(
    { error: { code: "forbidden", message: "Admin access required" } },
    403
  )
}

/**
 * Require a specific admin scope. Returns 401 if unauthenticated, 403 if the
 * user is neither a super_admin nor a holder of `scope`.
 */
export function requireAdminScope(scope: AdminScope) {
  return async (c: Context, next: Next) => {
    const auth = c.get("auth")
    if (!auth?.userId) return unauthorized(c)

    const access = await getAdminAccess(auth.userId)
    if (access.isSuperAdmin || access.scopes.includes(scope)) {
      await next()
      return
    }
    return forbidden(c)
  }
}

/**
 * Require *any* admin access: super_admin, or at least one granted scope.
 * Used to gate entry to the admin portal as a whole.
 */
export async function requireAnyAdmin(c: Context, next: Next) {
  const auth = c.get("auth")
  if (!auth?.userId) return unauthorized(c)

  const access = await getAdminAccess(auth.userId)
  if (access.isSuperAdmin || access.scopes.length > 0) {
    await next()
    return
  }
  return forbidden(c)
}
