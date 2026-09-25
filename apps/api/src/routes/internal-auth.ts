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
import {
  authenticateRuntimeToken,
  createInternalAuthorizers,
  logAuthReject,
  type InternalIdentity,
} from './internal-runtime-auth'

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

const authorizers = createInternalAuthorizers(authenticate)

/** Boolean form for project-scoped routes, where the path param is the scope. */
export const validateAuth = authorizers.validateAuth
export const authorizeWorkspaceScope = authorizers.authorizeWorkspaceScope
export const authorizeWorkspaceRuntimeRequest = authorizers.authorizeWorkspaceRuntimeRequest
