// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Super Admin Middleware
 *
 * Checks that the authenticated user has the 'super_admin' role.
 * Must be used after authMiddleware + requireAuth.
 *
 * Usage:
 * ```typescript
 * app.use('/api/admin/*', authMiddleware)
 * app.use('/api/admin/*', requireAuth)
 * app.use('/api/admin/*', requireSuperAdmin)
 * ```
 */

import type { Context, Next } from "hono"
import { prisma } from "../lib/prisma"

/**
 * Middleware that requires super_admin role.
 * Returns 403 Forbidden if the user is not a super admin.
 */
export async function requireSuperAdmin(c: Context, next: Next) {
  const auth = c.get("auth")

  if (!auth?.userId) {
    return c.json(
      { error: { code: "unauthorized", message: "Authentication required" } },
      401
    )
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { role: true },
  })

  if (!user || user.role !== "super_admin") {
    return c.json(
      { error: { code: "forbidden", message: "Super admin access required" } },
      403
    )
  }

  await next()
}
