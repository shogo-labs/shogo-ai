// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `x-runtime-token` half of the `/api/internal/*` auth primitives.
 *
 * Kept free of `../lib/k8s-auth` (and so `@kubernetes/client-node`) so the
 * slim desktop composer (`app/create-local-app.ts`) can authenticate its
 * agent-runtime without pulling the cluster auth stack into the local
 * bundle. `internal-auth.ts` layers the ServiceAccount check on top.
 */

import type { Context } from 'hono'

export function logAuthReject(reason: string, projectId?: string): void {
  console.warn(`[InternalAuth] rejected: ${reason}${projectId ? ` projectId=${projectId}` : ''}`)
}

/**
 * Who authenticated an internal request.
 *
 * `sa` is cluster-scoped (a real K8s ServiceAccount, only obtainable inside
 * the cluster). `project` and `workspace` are HMAC bearer capabilities that a
 * runtime holds in env, so an agent can read its own token — which means they
 * must never be treated as cluster-scoped. Routes that take a `workspaceId`
 * from the request body have to cross-check it against the token's scope; see
 * `authorizeWorkspaceScope`.
 */
export type InternalIdentity =
  | { kind: 'sa' }
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; workspaceId: string }

/**
 * Verify the HMAC-signed `x-runtime-token`.
 *
 * Two runtime topologies present different token types:
 *   - Legacy single-project runtime → PROJECT token (`rt_v1_<projectId>_…`),
 *     verified by `verifyRuntimeToken`.
 *   - Universal workspace (merged-root) runtime → WORKSPACE token
 *     (`wrt_v1_<workspaceId>_…`), verified by `verifyWorkspaceRuntimeToken`.
 *     For project-scoped routes we additionally confirm the project belongs
 *     to the token's workspace so a workspace token can't act on a project
 *     in another workspace.
 *
 * `hadBearer` only shapes the reject reason logged when no token is present.
 */
export async function authenticateRuntimeToken(
  c: Context,
  projectId?: string,
  hadBearer = false,
): Promise<InternalIdentity | null> {
  const runtimeToken = c.req.header('x-runtime-token')
  if (!runtimeToken) {
    logAuthReject(hadBearer ? 'invalid_sa_token_and_no_runtime_token' : 'missing_credentials', projectId)
    return null
  }

  const { verifyRuntimeToken } = await import('../lib/runtime-token')
  const verified = verifyRuntimeToken(runtimeToken, projectId)
  if (verified.ok) {
    if (!projectId || verified.projectId === projectId) {
      return { kind: 'project', projectId: verified.projectId }
    }
    logAuthReject(`runtime_token_project_mismatch tokenProject=${verified.projectId}`, projectId)
    return null
  }

  const { verifyWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
  const wsVerified = verifyWorkspaceRuntimeToken(runtimeToken)
  if (wsVerified.ok) {
    if (!projectId) return { kind: 'workspace', workspaceId: wsVerified.workspaceId }
    const { resolveProjectWorkspaceId } = await import('../lib/project-runtime-token')
    const workspaceId = await resolveProjectWorkspaceId(projectId)
    if (workspaceId === wsVerified.workspaceId) {
      return { kind: 'workspace', workspaceId: wsVerified.workspaceId }
    }
    logAuthReject(
      `workspace_token_mismatch tokenWorkspace=${wsVerified.workspaceId} projectWorkspace=${workspaceId ?? 'none'}`,
      projectId,
    )
    return null
  }

  logAuthReject(`runtime_token_invalid reason=${verified.reason}`, projectId)
  return null
}

export type InternalAuthenticate = (c: Context, projectId?: string) => Promise<InternalIdentity | null>

/**
 * Scope checks layered on an `authenticate` strategy: SA + runtime token in
 * the cloud (`internal-auth.ts`), runtime token only on desktop.
 */
export function createInternalAuthorizers(authenticate: InternalAuthenticate) {
  /** Boolean form for project-scoped routes, where the path param is the scope. */
  async function validateAuth(c: Context, projectId?: string): Promise<boolean> {
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
  async function authorizeWorkspaceScope(
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
   */
  async function authorizeWorkspaceRuntimeRequest(
    c: Context,
    workspaceId: string,
  ): Promise<InternalIdentity | null> {
    const identity = await authenticate(c)
    if (!identity) return null
    if (identity.kind === 'project') return null
    if (identity.kind === 'workspace' && identity.workspaceId !== workspaceId) return null
    return identity
  }

  return { validateAuth, authorizeWorkspaceScope, authorizeWorkspaceRuntimeRequest }
}
