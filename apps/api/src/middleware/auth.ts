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
  /** True when the session check failed due to a server-side error (DB, etc.) */
  authError?: boolean
  /**
   * How the request was authenticated. Set by `authMiddleware`.
   * Used by voice routes and other dual-mode endpoints that need to
   * branch on credential type (e.g. to skip session-cookie-only
   * behaviors for SDK callers).
   */
  via?: 'apiKey' | 'session' | 'tunnel'
  /**
   * True when the request was authenticated via tunnel headers
   * (x-tunnel-auth-user-id). The cloud proxy already verified workspace
   * membership, so local DB membership checks can be skipped.
   */
  tunnelAuthenticated?: boolean
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
          via: 'apiKey',
        })
        await next()
        return
      }
    } catch {}
  }

  // 2. Try tunnel-forwarded auth (from cloud proxy via instance tunnel).
  //    The cloud transparent proxy authenticates the user via session cookie,
  //    then injects x-tunnel-auth-user-id into the tunnel request. The
  //    desktop's tunnel handler (instance-tunnel.ts) forwards this header
  //    when it sends the request to localhost. We trust it because:
  //    - The tunnel handler runs in-process (loopback to our own API port)
  //    - The cloud proxy already verified the session
  //    - External requests can't reach this header without going through the tunnel
  const tunnelUserId = c.req.header("x-tunnel-auth-user-id")
  if (tunnelUserId) {
    c.set("auth", {
      userId: tunnelUserId,
      email: c.req.header("x-tunnel-auth-email") || undefined,
      name: c.req.header("x-tunnel-auth-name") || undefined,
      isAuthenticated: true,
      tunnelAuthenticated: true,
      via: 'tunnel',
    })
    await next()
    return
  }

  // 3. Try Better Auth session (cookies)
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
        via: 'session',
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
      authError: true,
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
    if (auth?.authError) {
      return c.json(
        { error: { code: "service_unavailable", message: "Auth service temporarily unavailable" } },
        503
      )
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

  // Tunnel-authenticated requests already had workspace membership verified
  // by the cloud proxy — skip local DB membership checks.
  if (auth?.tunnelAuthenticated) {
    await next()
    return
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

/**
 * Paths under /api/projects/* that are NOT project-scoped (no :projectId
 * segment) and therefore must bypass the /api/projects/:projectId/*
 * middleware that calls requireProjectAccess. Without this bypass Hono's
 * wildcard matching treats the reserved word as a projectId and
 * requireProjectAccess 404s with "Project not found" before the real
 * handler ever runs.
 */
export const PROJECT_RESERVED_TOP_LEVEL_PATHS: ReadonlySet<string> = new Set([
  "/api/projects/import",
])

export function isProjectReservedTopLevelPath(path: string): boolean {
  return PROJECT_RESERVED_TOP_LEVEL_PATHS.has(path)
}

/**
 * Dual-mode auth middleware for routes that must accept either a
 * Shogo API key (`Authorization: Bearer shogo_sk_*`) or a Better Auth
 * session cookie. Returns 401 on neither.
 *
 * Relies on `authMiddleware` having already populated `c.get('auth')`.
 * The API server mounts `authMiddleware` at `/api/*`, so this
 * middleware just asserts the result for voice / telephony routes that
 * are intentionally reachable both from in-app browser UI (cookie) and
 * from third-party SDK consumers (bearer key).
 *
 * Resolution precedence (inherited from authMiddleware):
 *   1. Authorization: Bearer shogo_sk_* → via: 'apiKey'
 *   2. x-tunnel-auth-user-id            → via: 'tunnel'
 *   3. Better Auth session cookie       → via: 'session'
 */
export async function apiKeyOrSession(c: Context, next: Next) {
  const authCtx = c.get('auth')
  if (!authCtx?.isAuthenticated || !authCtx.userId) {
    if (authCtx?.authError) {
      return c.json(
        { error: { code: 'service_unavailable', message: 'Auth service temporarily unavailable' } },
        503,
      )
    }
    return c.json(
      { error: { code: 'unauthorized', message: 'Shogo API key or session required' } },
      401,
    )
  }
  await next()
}

/**
 * Result of `authorizeProject` — either `{ ok: true, workspaceId }`
 * or an error payload with the HTTP status to return.
 */
export type AuthorizeProjectResult =
  | { ok: true; workspaceId: string; projectId: string }
  | { ok: false; status: 400 | 401 | 403 | 404; code: string; message: string }

/**
 * Verify the authenticated caller has access to `projectId`.
 *
 * - API-key callers: project.workspaceId must match auth.workspaceId.
 * - Session callers: caller must be a member of project.workspaceId.
 * - Tunnel callers: trusted (cloud proxy already verified membership).
 *
 * Returns a structured result instead of throwing / responding so
 * handlers can shape their own error envelope.
 */
export async function authorizeProject(
  c: Context,
  projectId: string,
): Promise<AuthorizeProjectResult> {
  const authCtx = c.get('auth')
  if (!authCtx?.isAuthenticated || !authCtx.userId) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'Authentication required',
    }
  }
  if (!projectId || typeof projectId !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'projectId is required',
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  })
  if (!project) {
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      message: 'Project not found',
    }
  }

  if (authCtx.via === 'apiKey') {
    if (!authCtx.workspaceId || authCtx.workspaceId !== project.workspaceId) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'Project is not in this API key\'s workspace',
      }
    }
    return { ok: true, workspaceId: project.workspaceId, projectId: project.id }
  }

  if (authCtx.tunnelAuthenticated) {
    return { ok: true, workspaceId: project.workspaceId, projectId: project.id }
  }

  // Session / other: verify workspace membership.
  const member = await prisma.member.findFirst({
    where: { userId: authCtx.userId, workspaceId: project.workspaceId },
    select: { id: true },
  })
  if (!member) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Access denied to this project',
    }
  }
  return { ok: true, workspaceId: project.workspaceId, projectId: project.id }
}
