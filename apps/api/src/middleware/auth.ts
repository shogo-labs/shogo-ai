// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auth Middleware for Hono Routes
 *
 * Extracts the authenticated user from Better Auth session
 * and makes it available to route handlers via c.get("auth").
 *
 * Four auth modes, resolved in this order:
 *   1. `Authorization: Bearer shogo_sk_*` → `via: 'apiKey'`
 *   2. `x-runtime-token` (+ projectId)    → `via: 'runtimeToken'`
 *   3. `x-tunnel-auth-user-id`             → `via: 'tunnel'`
 *   4. Better Auth session cookie          → `via: 'session'`
 *
 * Runtime-token callers: see ../lib/runtime-token.md for operator-facing
 * gotchas (secret rotation, project-owner userId resolution, pod =
 * capability boundary, timing-safe compare). Any change to the
 * runtime-token branch below should be cross-checked against that doc.
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
import { verifyRuntimeToken } from "../lib/runtime-token"
import type { Permission } from "@shogo/authz"
import { authorize, decide, denialResponse, getAccess } from "../lib/authz"
import { projectRoutePermission } from "../lib/authz/project-routes"

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
  /** Workspace ID (set when authenticated via API key or runtime token) */
  workspaceId?: string
  /**
   * Project ID bound to this request. Currently set only by the
   * `runtimeToken` auth path — the token is scoped to a single project,
   * and downstream code (e.g. `authorizeProject`, `requireProjectAccess`)
   * uses this to verify the requested project matches the token scope.
   */
  projectId?: string
  /** Whether the request is authenticated */
  isAuthenticated: boolean
  /** True when the session check failed due to a server-side error (DB, etc.) */
  authError?: boolean
  /**
   * How the request was authenticated. Set by `authMiddleware`.
   * Used by voice routes and other dual-mode endpoints that need to
   * branch on credential type (e.g. to skip session-cookie-only
   * behaviors for SDK callers).
   *
   * `runtimeToken` is set when the caller presented a valid
   * `x-runtime-token` (or `Authorization: Bearer <token>` that is not a
   * `shogo_sk_` key) matching `deriveRuntimeToken(projectId)` for a
   * project supplied via query / route param. For such callers,
   * `userId` is the resolved project-owner (a real `user` row — see
   * ../lib/runtime-token.md §3: project-scoped Member role=owner,
   * falling back to workspace-scoped). This is representation, not an
   * identity assertion; the capability is still project-scoped.
   * Code that must refuse runtime callers branches on
   * `via === 'runtimeToken'`, never on a userId string shape.
   */
  via?: 'apiKey' | 'session' | 'tunnel' | 'runtimeToken'
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
    /**
     * Workspace this request acts on, cached by `requireProjectAccess` (and the
     * workspace-id resolver) so the home-region write router doesn't re-query.
     */
    workspaceId?: string
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

  // 2. Try runtime-token auth (pod → API, project-scoped capability).
  //    Every Shogo-managed pod is started with env:
  //      PROJECT_ID           — the project this pod serves
  //      RUNTIME_AUTH_SECRET  — v1 token: `rt_v1_<projectId>_<hmac>`
  //    When user code running inside the pod calls the Shogo API on
  //    behalf of the project, it forwards `x-runtime-token: $RUNTIME_AUTH_SECRET`
  //    (or equivalent `Authorization: Bearer <token>`).
  //
  //    `verifyRuntimeToken` handles both:
  //      - v1 self-identifying tokens — projectId is recovered from the
  //        token itself, so this works for routes that carry projectId in
  //        the path (`:projectId`), query string, body, or nowhere at all.
  //      - Legacy bare-hex tokens — require a `fallbackProjectId` from
  //        query / route param. Kept only until all pre-v1 pods have
  //        cycled; see `../lib/runtime-token.ts`.
  //
  //    Project-scoped → downstream `authorizeProject` still verifies the
  //    requested project matches `authCtx.projectId`. The token embedding
  //    the scope does NOT replace that check — it only supplies the scope
  //    to this middleware without relying on path introspection.
  const runtimeToken =
    c.req.header("x-runtime-token") ??
    (authHeader?.startsWith("Bearer ") && !authHeader.startsWith("Bearer shogo_sk_")
      ? authHeader.slice(7)
      : undefined)
  if (runtimeToken) {
    // Legacy-fallback projectId: only used when the token itself is
    // pre-v1 bare-hex and thus doesn't carry its own scope. v1 tokens
    // ignore this. NOTE: `c.req.param("projectId")` returns undefined
    // for wildcard-mounted middleware (`app.use('/api/*', …)`); the v1
    // format exists precisely so we don't need it to work.
    const legacyFallbackProjectId =
      c.req.query("projectId") ?? c.req.param("projectId") ?? undefined
    try {
      const verified = verifyRuntimeToken(runtimeToken, legacyFallbackProjectId)
      if (verified.ok) {
        const scopedProjectId = verified.projectId
        // Resolve a real owner userId in the same round-trip as the
        // project existence check. See ../lib/runtime-token.md §3:
        // AuthContext.userId for runtime-token callers is the project's
        // owner Member (project-scoped first, then workspace-scoped).
        // This is representation, not an identity assertion — the pod
        // did not authenticate as that user; `via === 'runtimeToken'`
        // remains the capability signal.
        const project = await prisma.project.findUnique({
          where: { id: scopedProjectId },
          select: {
            workspaceId: true,
            members: {
              where: { role: { in: ['owner', 'admin'] } },
              orderBy: { createdAt: 'asc' },
              select: { userId: true },
              take: 1,
            },
            workspace: {
              select: {
                members: {
                  where: { role: 'owner', projectId: null },
                  orderBy: { createdAt: 'asc' },
                  select: { userId: true },
                  take: 1,
                },
              },
            },
          },
        })
        const ownerUserId =
          project?.members[0]?.userId ??
          project?.workspace.members[0]?.userId
        if (project && ownerUserId) {
          c.set("auth", {
            userId: ownerUserId,
            workspaceId: project.workspaceId,
            projectId: scopedProjectId,
            isAuthenticated: true,
            via: 'runtimeToken',
          })
          await next()
          return
        }
        if (project && !ownerUserId) {
          // Project exists but has no owner in either scope. This
          // should not happen given workspace-creation invariants,
          // but we fall through (→ 401 at requireAuth) rather than
          // silently attributing to a random user.
          console.warn(
            "[authMiddleware] runtime-token: no owner resolvable for project",
            { path: c.req.path, projectId: scopedProjectId },
          )
        }
      }
    } catch (err) {
      // verify may throw in production if signing secret missing;
      // fall through to next auth path rather than 500.
      // NOTE: never log the incoming `runtimeToken` — it's a bearer
      // capability. The err itself should not contain the token, but
      // if future changes pass more context in, route them through
      // `redactSensitiveHeaders` first. The path is safe.
      console.warn(
        "[authMiddleware] runtime-token verify failed:",
        {
          path: c.req.path,
          message: err instanceof Error ? err.message : String(err),
        },
      )
    }
  }

  // 3. Try tunnel-forwarded auth (from cloud proxy via instance tunnel).
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

  // 4. Try Better Auth session (cookies)
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
export const PUBLIC_PREFIXES = [
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
  // Public OpenAI-compatible API — self-authenticates with a `shogo_sk_*` key.
  '/api/v1/',
  '/api/tools/',
  '/api/api-keys/validate',
  // Device-key heartbeat — the key in the body is the credential (verified in
  // `./routes/api-keys.ts`).
  '/api/api-keys/heartbeat',
  // Cloud-side device-code login entry. The CLI worker and the desktop
  // app both POST `/api/cli/login/start` (anonymous — registering a new
  // pending-state nonce) and GET `/api/cli/login/poll` / `/api/cli/login/state`
  // (anonymous — the state nonce is the secret). The `approve` and `deny`
  // endpoints under this prefix DO require an authenticated session and
  // gate themselves inside the handler (see `./routes/cli-auth.ts`) —
  // gating them again here would 401 the bridge page's cookie call
  // before that handler check ever runs, since the desktop client never
  // re-sends cloud session cookies from its embedded BrowserWindow.
  // Bug: cli-auth.ts (df168409, May 14 2026) shipped without this prefix
  // entry, so anonymous `start` requests were 401'd by this middleware
  // before reaching the route — breaking Cloud sign-in in the v1.7.x
  // desktop builds.
  '/api/cli/login/',
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

/** Request path after `/api/projects/:projectId` (e.g. `/publish`). */
function projectSubpath(path: string, projectId: string): string {
  const marker = `/projects/${projectId}`
  const at = path.indexOf(marker)
  if (at < 0) return ''
  return path.slice(at + marker.length)
}

/**
 * Middleware for `/api/projects/:projectId/*`: requires the permission the
 * route declares in `PROJECT_ROUTE_RULES` (reads need `project:read`,
 * writes `project:update` unless the table says otherwise).
 *
 * Must be applied AFTER authMiddleware and requireAuth so that
 * c.get("auth").userId is available.
 */
export async function requireProjectAccess(c: Context, next: Next) {
  const auth = c.get("auth")
  if (!auth?.userId) {
    return c.json(
      { error: { code: "unauthorized", message: "Authentication required" } },
      401
    )
  }

  // Tunnel-authenticated requests were already authorized by the cloud
  // proxy — skip local DB membership checks.
  if (auth.tunnelAuthenticated) {
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

  if (auth.via === 'runtimeToken' && auth.projectId !== projectId) {
    return c.json(
      { error: { code: "forbidden", message: "Runtime token scope mismatch" } },
      403
    )
  }

  const permission = projectRoutePermission(c.req.method, projectSubpath(c.req.path, projectId))
  const decision = await authorize(c, permission, { projectId })
  if (!decision.ok) return denialResponse(c, decision)

  // Cache the resolved workspace so the home-region write router can reuse it
  // without a second project lookup.
  if (decision.access.workspaceId) c.set("workspaceId", decision.access.workspaceId)
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
 *   1. Authorization: Bearer shogo_sk_*  → via: 'apiKey'
 *   2. x-runtime-token (+ projectId)     → via: 'runtimeToken'
 *   3. x-tunnel-auth-user-id             → via: 'tunnel'
 *   4. Better Auth session cookie        → via: 'session'
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
 * Verify the authenticated caller holds `permission` on `projectId`.
 *
 * - API-key callers: the key owner's current access, inside the key's workspace.
 * - Runtime-token callers: only the token's own project.
 * - Session callers: effective workspace/project role (see `@shogo/authz`).
 * - Tunnel callers: trusted (cloud proxy already authorized them).
 *
 * Returns a structured result instead of throwing / responding so
 * handlers can shape their own error envelope.
 */
export async function authorizeProject(
  c: Context,
  projectId: string,
  permission: Permission,
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

  const access = await getAccess(c, { projectId })
  if (!access.exists || !access.workspaceId) {
    return { ok: false, status: 404, code: 'not_found', message: 'Project not found' }
  }
  // API keys outside their workspace and runtime tokens for another project
  // resolve to no access, so they get the same 404 as a missing project.
  const decision = await decide(access, permission, authCtx, `${c.req.method} ${c.req.path}`)
  if (!decision.ok) {
    return { ok: false, status: decision.status, code: decision.code, message: decision.message }
  }
  return { ok: true, workspaceId: access.workspaceId, projectId }
}
