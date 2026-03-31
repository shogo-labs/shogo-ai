// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auth Middleware for Hono Routes
 *
 * Extracts the authenticated user from Better Auth session
 * and makes it available to route handlers via c.get("auth").
 *
 * Usage:
 * ```typescript
 * // Apply to all routes
 * app.use('/api/*', authMiddleware)
 *
 * // Access in routes
 * const { userId } = c.get("auth") ?? {}
 * ```
 */

import type { Context, Next } from "hono"
import { auth } from "../auth"
import { prisma } from "../lib/prisma"
import { resolveApiKey } from "../routes/api-keys"

/**
 * Auth context set by middleware
 */
export interface AuthContext {
  /** Authenticated user ID (undefined if not authenticated) */
  userId?: string
  /** User email */
  email?: string
  /** User name */
  name?: string
  /** Workspace ID (set when authenticated via API key) */
  workspaceId?: string
  /** Whether the request is authenticated */
  isAuthenticated: boolean
}

// Extend Hono context types
declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext
  }
}

/**
 * Auth middleware that extracts session from Better Auth.
 * Sets c.get("auth") with user info for downstream handlers.
 *
 * Does NOT block unauthenticated requests - that's the job of requireAuth.
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Try shogo_sk_* API key auth (used by local instances forwarding to cloud)
  const authHeader = c.req.header("authorization")
  if (authHeader?.startsWith("Bearer shogo_sk_")) {
    try {
      const result = await resolveApiKey(authHeader.slice(7))
      if (result) {
        c.set("auth", {
          userId: result.userId,
          workspaceId: result.workspaceId,
          isAuthenticated: true,
        })
        await next()
        return
      }
    } catch {}
  }

  // 2. Try Better Auth session (cookies)
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    })

    if (session?.user) {
      c.set("auth", {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name ?? undefined,
        isAuthenticated: true,
      })
    } else {
      c.set("auth", {
        isAuthenticated: false,
      })
    }
  } catch (error) {
    console.warn("[authMiddleware] Failed to get session:", error)
    c.set("auth", {
      isAuthenticated: false,
    })
  }

  await next()
}

/**
 * Middleware that requires authentication.
 * Returns 401 if user is not authenticated.
 *
 * Use after authMiddleware:
 * ```typescript
 * app.use('/api/*', authMiddleware)
 * app.use('/api/*', requireAuth)
 * ```
 */
const PUBLIC_PREFIXES = [
  '/api/auth/',
  '/api/health',
  '/api/version',
  '/api/config',
  '/api/webhooks/',
  '/api/integrations/',
  '/api/invite-links/',
  '/api/internal/',
  '/api/local/',
  '/api/ai/',
  '/api/tools/',
  '/api/api-keys/validate',
]

export async function requireAuth(c: Context, next: Next) {
  const auth = c.get("auth")

  if (!auth?.isAuthenticated || !auth.userId) {
    const path = new URL(c.req.url).pathname
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      return next()
    }
    return c.json(
      { error: { code: "unauthorized", message: "Authentication required" } },
      401
    )
  }

  await next()
}

/**
 * Middleware that requires a specific role.
 * Use with membership checks in hooks for workspace-level authorization.
 *
 * @param role - Required role (or array of acceptable roles)
 */
export function requireRole(role: string | string[]) {
  const roles = Array.isArray(role) ? role : [role]

  return async (c: Context, next: Next) => {
    const auth = c.get("auth")

    if (!auth?.isAuthenticated) {
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401
      )
    }

    // Role checking is done at the hook level with workspace membership
    // This middleware just ensures auth context exists
    // Actual role validation happens in beforeList/beforeGet hooks

    await next()
  }
}

/**
 * Middleware that verifies the authenticated user has access to the
 * project specified by the `:projectId` route parameter.
 *
 * Access is granted if the user is a member of the project's workspace,
 * or if the user has the super_admin role.
 *
 * Must be applied AFTER authMiddleware and requireAuth so that
 * c.get("auth").userId is available.
 */
export async function requireProjectAccess(c: Context, next: Next) {
  const auth = c.get("auth")
  const userId = auth?.userId
  if (!userId) {
    return c.json(
      { error: { code: "unauthorized", message: "Authentication required" } },
      401
    )
  }

  const projectId = c.req.param("projectId")
  if (!projectId) {
    return c.json(
      { error: { code: "bad_request", message: "Project ID is required" } },
      400
    )
  }

  // Super admins bypass project access checks
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })
  if (user?.role === "super_admin") {
    await next()
    return
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) {
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404
    )
  }

  const member = await prisma.member.findFirst({
    where: { userId, workspaceId: project.workspaceId },
  })
  if (!member) {
    return c.json(
      { error: { code: "forbidden", message: "Access denied to this project" } },
      403
    )
  }

  await next()
}
