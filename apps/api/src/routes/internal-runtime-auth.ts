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

/** Boolean form for project-scoped routes on the desktop composer. */
export async function validateRuntimeTokenAuth(c: Context, projectId?: string): Promise<boolean> {
  return (await authenticateRuntimeToken(c, projectId)) !== null
}
