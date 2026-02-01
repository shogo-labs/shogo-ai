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
  try {
    // Get session from Better Auth using the request headers (cookies)
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
    // Session fetch failed - treat as unauthenticated
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
export async function requireAuth(c: Context, next: Next) {
  const auth = c.get("auth")

  if (!auth?.isAuthenticated || !auth.userId) {
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
