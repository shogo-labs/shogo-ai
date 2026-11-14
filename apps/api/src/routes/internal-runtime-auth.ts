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

/**
 * The reject line operators grep for. `route` is the one field that makes a
 * reject attributable: without it a `bad_hmac` burst says which project was
 * addressed but not which call the runtime was making, so nobody can tell a
 * `project_call` from a token-validation round-trip (SHO-265). Nothing secret
 * is ever logged — the token itself never appears here.
 */
export function logAuthReject(reason: string, projectId?: string, route?: string): void {
  console.warn(
    `[InternalAuth] rejected: ${reason}` +
      `${projectId ? ` projectId=${projectId}` : ''}` +
      `${route ? ` route=${route}` : ''}`,
  )
}

/** `GET /api/internal/projects/x/agent-call` for the reject line. */
export function requestRoute(c: Context): string {
  return `${c.req.method} ${c.req.path}`
}

/** Runtime keys a merged-root runtime uses for itself; never a project id. */
const WORKSPACE_RUNTIME_KEY_PREFIX = 'ws:'

/**
 * Turn the project reference on a project-scoped internal route into a real
 * project id.
 *
 * A workspace runtime names itself `ws:<workspaceId>`, and that key reaches
 * `/api/internal/projects/:projectId/...` from callers that hold it and pass it
 * straight through. The lookup then resolves no project and prod logged the
 * result as `workspace_token_mismatch … projectWorkspace=none projectId=ws:…`,
 * a 401 that reads as a token failure and hides the real mistake (SHO-265).
 *
 * Returns null for a workspace key, which cannot name a single project, so the
 * caller can say so instead of blaming the token.
 */
export function projectIdFromRef(ref: string): string | null {
  const key = ref.trim()
  if (key.startsWith(WORKSPACE_RUNTIME_KEY_PREFIX)) return null
  return key || null
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
  const route = requestRoute(c)
  const runtimeToken = c.req.header('x-runtime-token')
  if (!runtimeToken) {
    logAuthReject(hadBearer ? 'invalid_sa_token_and_no_runtime_token' : 'missing_credentials', projectId, route)
    return null
  }

  const { verifyRuntimeToken } = await import('../lib/runtime-token')
  const verified = verifyRuntimeToken(runtimeToken, projectId)
  if (verified.ok) {
    if (!projectId || verified.projectId === projectId) {
      return { kind: 'project', projectId: verified.projectId }
    }
    logAuthReject(`runtime_token_project_mismatch tokenProject=${verified.projectId}`, projectId, route)
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
      route,
    )
    return null
  }

  // Name the token kind that actually failed. `verifyRuntimeToken` answers
  // `malformed` for a `wrt_v1_…` token (it isn't its format), so a workspace
  // token with a bad HMAC would otherwise be logged as a parse error on the
  // project path and send whoever reads the log after the wrong problem; the
  // workspace verifier is the one that judged it (SHO-265).
  if (wsVerified.reason === 'bad_hmac') {
    logAuthReject('workspace_token_invalid reason=bad_hmac', projectId, route)
    return null
  }
  logAuthReject(`runtime_token_invalid reason=${verified.reason}`, projectId, route)
  return null
}

export type InternalAuthenticate = (c: Context, projectId?: string) => Promise<InternalIdentity | null>

/**
 * Why a route refused, in the shape the runtime can act on. `code` is the
 * contract (`cross_workspace_forbidden`, `approval_required`, …); the message
 * says which of the four conditions failed, so nobody has to guess (SHO-389).
 */
export interface ScopeDenial {
  ok: false
  status: 401 | 403
  code: string
  message: string
}

export type ScopeAllowance = { ok: true; identity: InternalIdentity; userId: string | null }

/** Context slot the authorizers leave a structured refusal in. */
export const SCOPE_DENIAL_KEY = 'internalScopeDenial'

/** Context slot an allowed call leaves the requester in (cross-workspace only). */
export const SCOPE_ALLOWANCE_KEY = 'internalScopeAllowance'

/**
 * The person a cross-workspace call is made for, or null for a call in the
 * runtime's own workspace. Board and chat writes attribute the row to them.
 */
export function scopeRequesterUserId(c: Context): string | null {
  const allowance = (c as any).get?.(SCOPE_ALLOWANCE_KEY) as ScopeAllowance | undefined
  return allowance?.userId ?? null
}

/** The response for a refused scope call: the structured 403, else a plain 401. */
export function scopeDenied(c: Context): Response {
  const denial = (c as any).get?.(SCOPE_DENIAL_KEY) as ScopeDenial | undefined
  if (!denial) return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ error: { code: denial.code, message: denial.message } }, denial.status)
}

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
   *
   * A **different** workspace is allowed only for the person's Personal
   * workspace agent, and a write only with a per-call approval — see
   * `authorizeCrossWorkspace`. The boolean stays the same shape so the routes
   * that only branch on yes/no keep working; a refusal also leaves its reason
   * on the context for `scopeDenied(c)`.
   */
  async function authorizeWorkspaceScope(
    c: Context,
    workspaceId: string | null,
    projectId?: string,
    opts: { write?: boolean } = {},
  ): Promise<boolean> {
    const result = await authorizeCrossWorkspace(c, workspaceId, projectId, opts)
    if (result.ok) {
      try {
        ;(c as any).set?.(SCOPE_ALLOWANCE_KEY, result)
      } catch {
        /* a plain test stub without set() */
      }
      return true
    }
    try {
      ;(c as any).set?.(SCOPE_DENIAL_KEY, result)
    } catch {
      /* a plain test stub without set() — the boolean still carries the answer */
    }
    logAuthReject(`${result.code}${result.message ? ` ${result.message}` : ''}`, projectId)
    return false
  }

  /**
   * The one authorizer for every route that acts in a workspace (SHO-389).
   *
   * Same-workspace calls answer exactly as they always have. A call to another
   * workspace is allowed when **all** of these hold:
   *
   *   1. the token is a `workspace` token whose workspace is `kind: personal`;
   *   2. `X-Requester-Ticket` verifies in that workspace and its user owns it;
   *   3. that user is a member of the target with the permission the route
   *      needs (read, or write);
   *   4. for a write, `X-Cross-Workspace-Approval` names an approved, unspent
   *      approval whose target, tool and args-hash match this request.
   *
   * Anything else is a `cross_workspace_forbidden` whose message names the
   * condition that failed — never an empty 200.
   *
   * `opts.write` defaults to "anything that is not a GET/HEAD", which is the
   * same line every agent tool's read/write pair falls on. A route that reads
   * through a POST passes `write: false`.
   */
  async function authorizeCrossWorkspace(
    c: Context,
    workspaceId: string | null,
    projectId?: string,
    opts: { write?: boolean } = {},
  ): Promise<ScopeAllowance | ScopeDenial> {
    const identity = await authenticate(c, projectId)
    if (!identity) {
      return { ok: false, status: 401, code: 'unauthorized', message: 'Unauthorized' }
    }
    if (identity.kind === 'sa') return { ok: true, identity, userId: null }
    if (!workspaceId) {
      return {
        ok: false,
        status: 403,
        code: 'workspace_scope_required',
        message: 'This call must name the workspace it acts in.',
      }
    }

    const tokenWorkspaceId =
      identity.kind === 'workspace'
        ? identity.workspaceId
        : await (await import('../lib/project-runtime-token')).resolveProjectWorkspaceId(identity.projectId)

    if (tokenWorkspaceId === workspaceId) {
      const sameWorkspace: ScopeAllowance = { ok: true, identity, userId: null }
      try {
        ;(c as any).set?.(SCOPE_ALLOWANCE_KEY, sameWorkspace)
      } catch {
        /* a plain test stub without set() */
      }
      return sameWorkspace
    }

    const cross = await authorizeCrossWorkspaceTarget(c, { identity, tokenWorkspaceId, targetWorkspaceId: workspaceId, write: opts.write })
    if (cross.ok) {
      try {
        ;(c as any).set?.(SCOPE_ALLOWANCE_KEY, cross)
      } catch {
        /* a plain test stub without set() */
      }
    }
    return cross
  }

  async function authorizeCrossWorkspaceTarget(
    c: Context,
    input: {
      identity: InternalIdentity
      tokenWorkspaceId: string | null
      targetWorkspaceId: string
      write?: boolean
    },
  ): Promise<ScopeAllowance | ScopeDenial> {
    const { identity, tokenWorkspaceId, targetWorkspaceId } = input
    const write = input.write ?? (c.req.method !== 'GET' && c.req.method !== 'HEAD')
    const forbidden = (code: string, message: string): ScopeDenial => ({ ok: false, status: 403, code, message })

    const { prisma } = await import('../lib/prisma')
    const db = prisma as any
    const caller = tokenWorkspaceId
      ? await db.workspace
          .findUnique({ where: { id: tokenWorkspaceId }, select: { kind: true, personalOwnerId: true } })
          .catch(() => null)
      : null

    if (identity.kind !== 'workspace' || !caller) {
      return forbidden(
        'cross_workspace_forbidden',
        'Only the Personal workspace agent may act in another workspace. A project agent is limited to its own workspace.',
      )
    }
    if (caller.kind !== 'personal') {
      return forbidden(
        'cross_workspace_forbidden',
        'Only the Personal workspace agent may act in another workspace; this is a team workspace.',
      )
    }

    const { REQUESTER_TICKET_HEADER, verifyRequesterTicketInWorkspace } = await import('../lib/requester-ticket')
    const ticket = await verifyRequesterTicketInWorkspace(c.req.header(REQUESTER_TICKET_HEADER), tokenWorkspaceId!)
    if (!ticket) {
      return forbidden(
        'requester_ticket_required',
        "This call can't be attributed to a person: no valid requester ticket for the Personal workspace. Start the turn from that person's chat.",
      )
    }
    if (caller.personalOwnerId !== ticket.userId) {
      return forbidden(
        'not_personal_owner',
        "This call is for a person who doesn't own that Personal workspace, so it can't act in another workspace.",
      )
    }

    const { targetAccessAllows, targetWorkspaceAccess } = await import('../lib/cross-workspace')
    const access = await targetWorkspaceAccess(ticket.userId, targetWorkspaceId)
    if (!targetAccessAllows(access, write)) {
      return forbidden(
        'not_a_member',
        `You are not a member of the target workspace (or your role there can't ${write ? 'change' : 'read'} it), so this call was refused. Only workspaces you belong to are reachable.`,
      )
    }

    let approvalId: string | null = null
    if (write) {
      const {
        CROSS_WORKSPACE_APPROVAL_HEADER,
        CROSS_WORKSPACE_TOOL_HEADER,
        CROSS_WORKSPACE_ARGS_HEADER,
        spendCrossWorkspaceApproval,
      } = await import('../lib/cross-workspace')
      approvalId = c.req.header(CROSS_WORKSPACE_APPROVAL_HEADER) ?? null
      const spent = await spendCrossWorkspaceApproval({
        approvalId,
        targetWorkspaceId,
        tool: c.req.header(CROSS_WORKSPACE_TOOL_HEADER),
        argsHash: c.req.header(CROSS_WORKSPACE_ARGS_HEADER),
      })
      if (!spent.ok) return spent as ScopeDenial
    }

    const { recordCrossWorkspaceCall } = await import('../lib/cross-workspace')
    await recordCrossWorkspaceCall({
      callerWorkspaceId: tokenWorkspaceId!,
      targetWorkspaceId,
      tool: c.req.header('X-Cross-Workspace-Tool') ?? `${c.req.method} ${c.req.path}`,
      userId: ticket.userId,
      write,
      approvalId,
    })

    return { ok: true, identity, userId: ticket.userId }
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

  return {
    validateAuth,
    authorizeWorkspaceScope,
    authorizeWorkspaceRuntimeRequest,
    authorizeCrossWorkspace,
    /** The cross-workspace half alone, for routes that already know the target. */
    authorizeCrossWorkspaceTarget,
  }
}
