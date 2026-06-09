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
import { requireSuperAdmin } from "./super-admin"

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

/**
 * Paths under /api/admin/* whose authorization is delegated to a granular
 * admin scope by the hand-written adminRoutes() router (creators:read,
 * analytics:read) rather than to blanket super_admin.
 *
 * Why this exists: the generated CRUD router (createAdminRoutes) is mounted at
 * /api/admin with `requireSuperAdmin` applied as `use("*", …)`. Hono folds a
 * sub-router's wildcard middleware into the *parent* chain for the shared
 * /api/admin prefix, so that gate also runs for the scoped routes served by
 * the separately-mounted adminRoutes() router — 403'ing partial admins before
 * requireAdminScope can run. (Same leakage hazard documented on
 * userAttributionRoute in routes/admin.ts.) requireSuperAdminUnlessScoped
 * defers these exact paths so the custom router's per-scope gate decides;
 * everything else under /api/admin stays super_admin-only.
 *
 * Keep in sync with the scope gates in apps/api/src/routes/admin.ts:
 *   - GET /creators                 → creators:read
 *   - GET /analytics/*              → analytics:read
 *   - /analytics/infra-current|history → still super_admin (excluded here)
 */
export function isScopeGatedAdminPath(path: string): boolean {
  if (path === "/api/admin/creators") return true
  if (
    path.startsWith("/api/admin/analytics/") &&
    path !== "/api/admin/analytics/infra-current" &&
    path !== "/api/admin/analytics/infra-history"
  ) {
    return true
  }
  return false
}

/**
 * Blanket super_admin gate for the generated admin CRUD router, with an
 * exception for scope-delegated paths (see isScopeGatedAdminPath). For those
 * paths it calls next(), letting the request fall through to the custom
 * adminRoutes() router whose requireAdminScope middleware performs the real
 * authorization. For every other /api/admin/* path it enforces super_admin.
 */
export async function requireSuperAdminUnlessScoped(c: Context, next: Next) {
  if (isScopeGatedAdminPath(c.req.path)) {
    await next()
    return
  }
  return requireSuperAdmin(c, next)
}
