// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auth primitives shared by every `/api/internal/*` route.
 *
 * Split out of `internal.ts` (previously ~1766 lines with authentication,
 * checkpoints, heartbeat, cost metrics, and workspace-runtime routes all in
 * one file) so the "who is allowed to call this?" logic has one home,
 * independent of which route groups get split out of `internal.ts` next.
 *
 * These are NOT exposed via external ingress — only reachable within the
 * K8s cluster (or, in local/desktop mode, trusted by construction).
 */

import type { Context } from 'hono'
import { validatePodToken } from '../lib/k8s-auth'
import { authenticateRuntimeToken, logAuthReject, type InternalIdentity } from './internal-runtime-auth'

export { logAuthReject, type InternalIdentity }

/**
 * Authenticate a request: K8s SA bearer first, then HMAC-signed runtime token.
 *
 * Runtime tokens are accepted in production, not only local mode. Metal
 * microVMs (and any runtime without a ServiceAccount token file) send
 * `x-runtime-token` with no `Authorization` header; gating that path on
 * `SHOGO_LOCAL_MODE` 401'd every publish/checkpoint from those runtimes.
 * `authMiddleware` already accepts the same credential in production across
 * `/api/*`, so this only removes an inconsistency — see ../lib/runtime-token.md.
 *
 * If a Bearer header is present but TokenReview fails, fall through to the
 * runtime token instead of dead-ending — a Knative pod whose SA token is
 * stale still carries a valid `x-runtime-token`. See `authenticateRuntimeToken`
 * for the project vs. workspace token rules.
 */
export async function authenticate(c: Context, projectId?: string): Promise<InternalIdentity | null> {
  const authHeader = c.req.header('Authorization')
  const hadBearer = authHeader?.startsWith('Bearer ') ?? false
  if (hadBearer) {
    const identity = await validatePodToken(authHeader!.slice(7))
    if (identity) return { kind: 'sa' }
    console.warn(
      `[InternalAuth] SA token rejected; falling through to runtime token` +
        `${projectId ? ` projectId=${projectId}` : ''}`,
    )
  }
  return authenticateRuntimeToken(c, projectId, hadBearer)
}

/** Boolean form for project-scoped routes, where the path param is the scope. */
export async function validateAuth(c: Context, projectId?: string): Promise<boolean> {
  return (await authenticate(c, projectId)) !== null
}

/**
 * Authorize a route whose target workspace comes from the request body rather
 * than a path param, so the token's own scope cannot be inferred from the URL.
 *
 * A runtime token is a project/workspace capability, not a cluster credential:
 * without this check any pod could write analytics rows against an arbitrary
 * `workspaceId`. SA callers are cluster-internal and stay unrestricted.
 */
export async function authorizeWorkspaceScope(
  c: Context,
  workspaceId: string | null,
  projectId?: string,
): Promise<boolean> {
  const identity = await authenticate(c, projectId)
  if (!identity) return false
  if (identity.kind === 'sa') return true
  if (!workspaceId) {
    logAuthReject(`workspace_scope_required identity=${identity.kind}`, projectId)
    return false
  }

  if (identity.kind === 'workspace') {
    if (identity.workspaceId === workspaceId) return true
    logAuthReject(
      `workspace_scope_mismatch tokenWorkspace=${identity.workspaceId} body=${workspaceId}`,
      projectId,
    )
    return false
  }

  const { resolveProjectWorkspaceId } = await import('../lib/project-runtime-token')
  const tokenWorkspaceId = await resolveProjectWorkspaceId(identity.projectId)
  if (tokenWorkspaceId && tokenWorkspaceId === workspaceId) return true
  logAuthReject(
    `workspace_scope_mismatch tokenProject=${identity.projectId} ` +
      `tokenWorkspace=${tokenWorkspaceId ?? 'none'} body=${workspaceId}`,
    projectId,
  )
  return false
}

/**
 * Authorize a route whose workspace comes from a `:workspaceId` PATH param
 * (as opposed to `authorizeWorkspaceScope`'s request-body case) and where a
 * `project`-scoped token is never valid — only `sa` or a matching
 * `workspace` token. Used by the workspace meta-agent membership routes
 * (list/mount/unmount), which are workspace-runtime-only operations.
 *
 * Hono-middleware-shaped (`(c) => Promise<Response | undefined>`) so it can
 * be mounted with `app.use('/workspaces/:workspaceId/*', ...)` once a route
 * group is fully path-scoped; today's call sites still call it inline
 * because a couple of routes need the resolved `InternalIdentity` for
 * downstream logic, which a `next()`-based middleware can't hand back
 * without stashing it on `c` — left as request-shaped rather than forcing
 * that now.
 */
export async function authorizeWorkspaceRuntimeRequest(
  c: Context,
  workspaceId: string,
): Promise<InternalIdentity | null> {
  const identity = await authenticate(c)
  if (!identity) return null
  if (identity.kind === 'project') return null
  if (identity.kind === 'workspace' && identity.workspaceId !== workspaceId) return null
  return identity
}
